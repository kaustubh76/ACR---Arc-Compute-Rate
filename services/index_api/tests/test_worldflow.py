"""The device grant's state machine, against a stubbed provider. Zero sockets.

Every outcome World documents gets a test, because the three that matter --
503, 429 and `slow_down` -- are exactly the ones a hand-rolled retry loop gets
wrong, and they only misbehave when the provider is having a bad day, which is
to say on stage.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest
from index_api.worldflow import (
    DEFAULT_INTERVAL_S,
    MAX_DEVICE_CODE_LIFETIME_S,
    DeviceFlow,
    essential_acr_claims,
    widen,
)

ISS = "https://auth.world.org"
ORB = "https://world.org/oidc/acr/orb"
SELFIE = "https://world.org/oidc/acr/selfie"

DISC = {
    "issuer": ISS,
    "device_authorization_endpoint": f"{ISS}/api/v1/device_authorization",
    "token_endpoint": f"{ISS}/api/v1/token",
    "jwks_uri": f"{ISS}/.well-known/jwks.json",
    "acr_values_supported": [ORB, f"{ISS}/orb-face"],
}

START_OK = {
    "device_code": "dev-secret-code",
    "user_code": "WDJB-MJHT",
    "verification_uri": "https://world.org/device",
    "verification_uri_complete": "https://world.org/device?user_code=WDJB-MJHT",
    "expires_in": 600,
    "interval": 5,
}


def _flow(handler, **over) -> DeviceFlow:
    kw = {
        "issuer": ISS,
        "client_id": "client_abc",
        "client_secret": "worldidp_client_secret_xyz",
        "transport": httpx.MockTransport(handler),
    }
    kw.update(over)
    return DeviceFlow(**kw)


def _routes(*, start=None, token=None, disc=None, seen=None):
    """A handler that answers discovery, start and token, recording requests."""

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        path = request.url.path
        if path.endswith("openid-configuration"):
            return httpx.Response(200, json=disc if disc is not None else DISC)
        if path.endswith("jwks.json"):
            return httpx.Response(200, json={"keys": [{"kty": "RSA", "kid": "k1"}]})
        if "device_authorization" in path:
            return start if start is not None else httpx.Response(200, json=START_OK)
        if path.endswith("/token"):
            return token if token is not None else httpx.Response(200, json={"id_token": "tok"})
        return httpx.Response(404)

    return handler


# --- the assurance request --------------------------------------------------


def test_the_assurance_request_is_an_essential_values_array():
    claims = json.loads(essential_acr_claims([ORB, SELFIE]))
    acr = claims["id_token"]["acr"]
    assert acr["essential"] is True
    assert acr["values"] == [ORB, SELFIE]
    #: The singular spelling is a DIFFERENT member of the OIDC claims syntax.
    #: Asking with it would request nothing and the token would come back with
    #: whatever class the account happened to have.
    assert "value" not in acr


def test_an_assurance_request_with_no_class_is_refused():
    with pytest.raises(ValueError, match="at least one class"):
        essential_acr_claims([])
    with pytest.raises(ValueError, match="at least one class"):
        essential_acr_claims(["", ""])


def test_the_start_request_carries_the_essential_claim_and_the_openid_scope():
    seen: list[httpx.Request] = []
    _flow(_routes(seen=seen)).start([ORB])
    start = [r for r in seen if "device_authorization" in r.url.path][0]
    body = parse_qs(start.content.decode())
    assert body["scope"] == ["openid"]
    acr = json.loads(body["claims"][0])["id_token"]["acr"]
    assert acr == {"essential": True, "values": [ORB]}


# --- client authentication --------------------------------------------------


def test_the_secret_authenticates_with_basic_and_never_reaches_the_body():
    seen: list[httpx.Request] = []
    _flow(_routes(seen=seen)).start([ORB])
    start = [r for r in seen if "device_authorization" in r.url.path][0]
    assert start.headers["authorization"].startswith("Basic ")
    assert "client_secret" not in start.content.decode()


def test_the_post_method_is_used_only_when_the_client_was_registered_that_way():
    seen: list[httpx.Request] = []
    _flow(_routes(seen=seen), auth_method="post").start([ORB])
    start = [r for r in seen if "device_authorization" in r.url.path][0]
    assert "authorization" not in start.headers
    assert parse_qs(start.content.decode())["client_secret"] == ["worldidp_client_secret_xyz"]


def test_an_unknown_auth_method_is_refused_rather_than_guessed():
    with pytest.raises(ValueError, match="basic"):
        _flow(_routes(), auth_method="private_key_jwt")


def test_a_flow_without_credentials_refuses_to_exist():
    with pytest.raises(ValueError, match="issuer, a client id and a client secret"):
        DeviceFlow(issuer=ISS, client_id="", client_secret="x")


# --- discovery --------------------------------------------------------------


def test_discovery_refuses_an_issuer_that_does_not_match():
    #: A redirect that quietly lands on somebody else's identity provider is
    #: the one failure a correct signature check cannot catch later.
    bad = dict(DISC, issuer="https://auth.evil.example")
    with pytest.raises(ValueError, match="is not the configured"):
        _flow(_routes(disc=bad)).start([ORB])


def test_discovery_is_fetched_once_and_then_remembered():
    seen: list[httpx.Request] = []
    flow = _flow(_routes(seen=seen))
    flow.start([ORB])
    flow.poll_once("dev-secret-code")
    flow.supported_acr()
    assert sum(1 for r in seen if r.url.path.endswith("openid-configuration")) == 1


def test_the_supported_classes_come_from_the_provider_not_from_us():
    assert _flow(_routes()).supported_acr()[0] == ORB


# --- the poll table ---------------------------------------------------------


def test_a_token_is_returned_when_the_human_approves():
    polled = _flow(_routes(token=httpx.Response(200, json={"id_token": "the-token"}))).poll_once(
        "d"
    )
    assert polled.kind == "token"
    assert polled.id_token == "the-token"


def test_a_pending_poll_keeps_waiting():
    r = httpx.Response(400, json={"error": "authorization_pending"})
    assert _flow(_routes(token=r)).poll_once("d").kind == "pending"


def test_slow_down_widens_every_later_interval_not_just_the_next_one():
    r = httpx.Response(400, json={"error": "slow_down"})
    polled = _flow(_routes(token=r)).poll_once("d")
    assert polled.kind == "slow_down"
    #: Two slow_downs must compound, and a pending poll afterwards must not
    #: spring the interval back to where it started.
    interval = DEFAULT_INTERVAL_S
    interval = widen(interval, polled)
    interval = widen(interval, polled)
    assert interval == DEFAULT_INTERVAL_S + 10
    pending = _flow(_routes(token=httpx.Response(400, json={"error": "authorization_pending"})))
    assert widen(interval, pending.poll_once("d")) == DEFAULT_INTERVAL_S + 10


def test_a_503_ends_the_attempt_and_is_never_an_approval():
    #: Checked before the body is parsed, so a 503 carrying a cheerful
    #: `{"id_token": ...}` still cannot approve a payment.
    r = httpx.Response(503, json={"id_token": "do-not-trust-me"})
    polled = _flow(_routes(token=r)).poll_once("d")
    assert polled.kind == "stop"
    assert polled.reason == "provider_unavailable"
    assert polled.id_token is None
    assert "never an approval" in polled.sentence


def test_a_429_ends_the_attempt_and_retry_after_does_not_override_the_stop():
    r = httpx.Response(429, headers={"retry-after": "60"}, json={"error": "slow_down"})
    polled = _flow(_routes(token=r)).poll_once("d")
    assert polled.kind == "stop"
    assert polled.reason == "rate_limited"
    #: Recorded for the debrief, and then ignored: the header is advice about
    #: when to ask again, not permission to keep this attempt alive.
    assert polled.retry_after == 60.0


def test_access_denied_never_claims_the_human_said_no():
    r = httpx.Response(400, json={"error": "access_denied"})
    polled = _flow(_routes(token=r)).poll_once("d")
    assert polled.kind == "stop"
    assert polled.reason == "refused_or_assurance_unmet"
    #: World returns this for a refusal, an unmet assurance class AND a subject
    #: mismatch. The sentence has to carry all three or the operator will debug
    #: the wrong one.
    assert "declined" in polled.sentence
    assert "assurance" in polled.sentence
    assert "enrolled treasurer" in polled.sentence


def test_an_expired_device_code_stops():
    r = httpx.Response(400, json={"error": "expired_token"})
    assert _flow(_routes(token=r)).poll_once("d").reason == "device_code_expired"


def test_a_200_with_no_id_token_stops_rather_than_polling_forever():
    r = httpx.Response(200, json={"token_type": "Bearer"})
    assert _flow(_routes(token=r)).poll_once("d").reason == "provider_error"


def test_an_unrecognised_error_stops_rather_than_retrying():
    r = httpx.Response(400, json={"error": "something_new_from_the_provider"})
    assert _flow(_routes(token=r)).poll_once("d").kind == "stop"


def test_an_unparseable_answer_stops():
    r = httpx.Response(200, content=b"<html>a load balancer wrote this</html>")
    assert _flow(_routes(token=r)).poll_once("d").kind == "stop"


# --- the device code is a secret -------------------------------------------


def test_the_device_code_never_appears_in_the_public_view():
    started = _flow(_routes()).start([ORB])
    assert started.device_code == "dev-secret-code"
    public = started.public()
    assert "dev-secret-code" not in json.dumps(public)
    assert set(public) == {"user_code", "verification_uri", "expires_in"}


def test_the_public_view_prefers_the_complete_uri_so_a_qr_fills_the_code_in():
    assert (
        _flow(_routes()).start([ORB]).public()["verification_uri"].endswith("user_code=WDJB-MJHT")
    )


# --- bounds ----------------------------------------------------------------


def test_a_device_code_lifetime_is_capped_at_the_documented_twenty_minutes():
    r = httpx.Response(200, json=dict(START_OK, expires_in=86_400))
    assert _flow(_routes(start=r)).start([ORB]).expires_in == MAX_DEVICE_CODE_LIFETIME_S


def test_a_zero_interval_is_floored_so_the_poll_cannot_busy_loop():
    r = httpx.Response(200, json=dict(START_OK, interval=0))
    assert _flow(_routes(start=r)).start([ORB]).interval == DEFAULT_INTERVAL_S


def test_a_start_that_answers_without_a_device_code_is_refused():
    r = httpx.Response(200, json={"user_code": "X", "verification_uri": "https://x"})
    with pytest.raises(ValueError, match="without device_code"):
        _flow(_routes(start=r)).start([ORB])


def test_a_refused_start_does_not_echo_the_request_into_the_error():
    r = httpx.Response(400, json={"error": "invalid_client", "claims": "secret-echo"})
    with pytest.raises(ValueError, match="HTTP 400") as exc:
        _flow(_routes(start=r)).start([ORB])
    assert "secret-echo" not in str(exc.value)
