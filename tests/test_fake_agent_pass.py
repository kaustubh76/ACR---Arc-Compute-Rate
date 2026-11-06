"""The local Agent Pass issuer, and the real device flow driven against it.

This is the first end-to-end witness `worldflow.py` has ever had. Its own unit
tests inject `httpx.MockTransport` and serve a JWKS of
`{"kty": "RSA", "kid": "k1"}` -- no modulus -- so they can only ever exercise
the state machine; every signature rung refuses by construction. And the
rehearsal builds `IdTokenValidator` directly with `jwks=lambda: [jwk_of(key)]`,
so it never reaches `worldflow` at all. Between the two, discovery, the
essential-`acr` claims parameter, the device grant and the poll table had no
test that ran them over a socket.

These do. Nothing is injected: the flow is configured with a URL and finds
everything else the way it would find World.

What that is NOT evidence of: anything about World. A local issuer says yes
because it was written to. The value is that the code BETWEEN our config and a
token is proven, not that the token means a person.
"""

from __future__ import annotations

import pathlib
import sys
import time

import pytest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "scripts"))
sys.path.insert(0, str(_ROOT / "services" / "index_api"))

from fake_agent_pass import ORB, ORB_FACE, jwk_of, keypair, serve  # noqa: E402
from index_api.worldauth import IdTokenValidator  # noqa: E402
from index_api.worldflow import DeviceFlow  # noqa: E402

CID = "fake-agent-pass-client"
SEC = "fake-agent-pass-secret"


def _flow(issuer: str) -> DeviceFlow:
    return DeviceFlow(issuer=issuer, client_id=CID, client_secret=SEC)


def _walk(fake, *, asked, accepted, jwks=None, treasurer=True):
    """Config -> discovery -> device grant -> poll -> the nine rungs."""
    flow = _flow(fake.issuer)
    opened = time.time()
    started = flow.start(asked)
    polled = flow.poll_once(started.device_code)
    if polled.kind != "token":
        return None, polled
    verdict = IdTokenValidator(
        issuer=fake.issuer,
        audience=CID,
        accepted_acr=list(accepted),
        jwks=jwks or flow.jwks,
        treasurer=(fake.issuer, fake.sub) if treasurer else None,
    ).check(polled.id_token, opened_at=opened)
    return verdict, polled


def test_discovery_echoes_its_own_base_url():
    #: `worldflow.discovery()` refuses when the document's issuer differs from
    #: the configured one -- the redirect hazard it exists to catch. A fake on
    #: an ephemeral port therefore has to know its port before it can answer,
    #: which is why the socket is bound first.
    with serve(quiet=True) as fake:
        disc = _flow(fake.issuer).discovery()
        assert disc["issuer"] == fake.issuer
        assert disc["claims_parameter_supported"] is True


def test_the_advertised_classes_are_the_two_the_real_issuers_advertise():
    with serve(quiet=True) as fake:
        assert _flow(fake.issuer).supported_acr() == (ORB, ORB_FACE)


def test_the_jwks_carries_a_real_modulus():
    #: The gap this fixture exists to close. A JWKS without `n`/`e` makes every
    #: signature rung refuse, so a green state-machine test says nothing about
    #: whether a token would ever verify.
    with serve(quiet=True) as fake:
        keys = _flow(fake.issuer).jwks()
        assert len(keys) == 1
        assert keys[0]["n"] and keys[0]["e"] and keys[0]["kty"] == "RSA"


def test_a_real_device_flow_clears_all_nine_rungs():
    with serve(pending_polls=0, quiet=True) as fake:
        verdict, _ = _walk(fake, asked=(ORB,), accepted=(ORB,))
        assert verdict.ok, verdict.reason
        assert verdict.claims.acr == ORB
        assert "pop" in verdict.claims.amr


def test_the_four_endpoints_are_all_actually_reached():
    #: The assertion that this test suite is about a protocol and not a mock.
    with serve(pending_polls=0, quiet=True) as fake:
        _walk(fake, asked=(ORB,), accepted=(ORB,))
        paths = " ".join(fake.requests)
        for endpoint in ("openid-configuration", "device_authorization", "/token", "jwks.json"):
            assert endpoint in paths, f"{endpoint} was never requested: {fake.requests}"


def test_a_face_class_asserts_face_in_amr():
    #: The policy gate reads `amr`, not only `acr`, so the two must agree.
    with serve(pending_polls=0, quiet=True) as fake:
        verdict, _ = _walk(fake, asked=(ORB_FACE,), accepted=(ORB_FACE,))
        assert verdict.ok, verdict.reason
        assert verdict.claims.acr == ORB_FACE
        assert "face" in verdict.claims.amr


def test_an_orb_token_is_refused_where_a_face_is_required():
    with serve(pending_polls=0, quiet=True) as fake:
        verdict, _ = _walk(fake, asked=(ORB,), accepted=(ORB_FACE,))
        assert not verdict.ok
        assert verdict.reason == "assurance_not_accepted"


def test_a_pending_poll_is_answered_before_the_token():
    #: Asserted by polling twice rather than by sleeping: `worldflow` floors the
    #: interval at five seconds, and a test that waits for it is a test nobody
    #: runs.
    with serve(pending_polls=1, quiet=True) as fake:
        flow = _flow(fake.issuer)
        started = flow.start((ORB,))
        first = flow.poll_once(started.device_code)
        assert first.kind == "pending"
        assert first.reason == "authorization_pending"
        assert flow.poll_once(started.device_code).kind == "token"


def test_an_unadvertised_essential_class_is_indistinguishable_from_a_refusal():
    #: The debrief's §2 complaint, as a fact rather than a reading of the docs.
    #: An essential `acr` the issuer cannot meet and a human saying no arrive as
    #: the SAME code, and the two assertions below are the same string.
    with serve(pending_polls=0, quiet=True, advertised=(ORB,)) as fake:
        _, unmet = _walk(fake, asked=(ORB_FACE,), accepted=(ORB_FACE,))
    with serve(pending_polls=0, quiet=True, deny=True) as fake:
        _, refused = _walk(fake, asked=(ORB,), accepted=(ORB,))
    assert unmet.kind == refused.kind == "stop"
    assert unmet.reason == refused.reason
    #: And the name our side gives it must not pick one of the three.
    assert unmet.reason == "refused_or_assurance_unmet"


def test_a_jwks_that_does_not_match_the_signer_refuses_the_token():
    #: The control. Without it every pass above could be a validator that
    #: accepts anything.
    other = keypair()
    with serve(pending_polls=0, quiet=True) as fake:
        verdict, polled = _walk(
            fake, asked=(ORB,), accepted=(ORB,), jwks=lambda: [jwk_of(other)]
        )
        assert polled.kind == "token"
        assert not verdict.ok
        assert verdict.reason == "bad_signature"


def test_a_different_subject_is_not_the_enrolled_treasurer():
    with serve(pending_polls=0, quiet=True, sub="somebody-else") as fake:
        flow = _flow(fake.issuer)
        opened = time.time()
        started = flow.start((ORB,))
        token = flow.poll_once(started.device_code).id_token
        verdict = IdTokenValidator(
            issuer=fake.issuer,
            audience=CID,
            accepted_acr=[ORB],
            jwks=flow.jwks,
            treasurer=(fake.issuer, "the-enrolled-one"),
        ).check(token, opened_at=opened)
        assert not verdict.ok
        assert verdict.reason == "not_the_enrolled_treasurer"


@pytest.mark.parametrize("port_attr", ["port"])
def test_the_issuer_binds_an_ephemeral_port(port_attr):
    #: Never a fixed port. Parallel sessions share this machine, and a fixed
    #: port is how one session's fixture silently answers another session's run.
    with serve(quiet=True) as a, serve(quiet=True) as b:
        assert getattr(a, port_attr) != getattr(b, port_attr)
        assert a.issuer != b.issuer


# --- the guest key: an Agent Pass identity as a one-per-human budget key -----
#
# The guest budget was built on Selfie Check, which World withdrew. Agent Pass
# answers the same question -- "is this a unique human" -- with a `sub` that is
# pairwise per client and stable, so it replaces the nullifier with no change to
# `guest_agent_id` and nothing at all on chain. These pin the property that
# makes that substitution safe.

from index_api.floatguest import guest_agent_id  # noqa: E402
from index_api.worldauth import treasurer_binding  # noqa: E402


def _guest_key(iss: str, sub: str) -> str:
    """The preimage the `guest` command hands to `guest_agent_id`."""
    return f"{iss}\x1f{sub}"


def test_the_guest_key_is_the_treasurer_binding_shape_with_a_different_prefix():
    #: Deliberately the same preimage as `treasurer_binding` -- iss, 0x1f, sub --
    #: so the two cannot drift apart in anyone's head. Only the domain prefix
    #: inside the hash differs, which is what keeps a treasurer and a guest from
    #: ever colliding.
    from eth_utils import keccak

    iss, sub = "https://sandbox.auth.world.org", "SUBJECT-A"
    assert guest_agent_id(_guest_key(iss, sub)) == keccak(
        b"acr.guest::" + f"{iss}\x1f{sub}".encode()
    )
    #: Same human, same two inputs, different answer per domain.
    assert "0x" + guest_agent_id(_guest_key(iss, sub)).hex() != treasurer_binding(iss, sub)


def test_the_same_human_always_gets_the_same_budget_id():
    #: This IS the one-per-human rule. If it were not stable the chain could
    #: never answer "has this person already been issued one", and every reload
    #: would mint a fresh budget.
    a = guest_agent_id(_guest_key("https://i", "SUB-1"))
    b = guest_agent_id(_guest_key("https://i", "SUB-1"))
    assert a == b


def test_two_humans_get_different_budget_ids():
    one = guest_agent_id(_guest_key("https://i", "SUB-1"))
    two = guest_agent_id(_guest_key("https://i", "SUB-2"))
    assert one != two


def test_the_same_subject_on_a_different_issuer_is_a_different_human():
    #: `sub` is pairwise per client, so it is only meaningful WITH its issuer.
    #: Dropping the issuer from the preimage would let a sandbox identity and a
    #: production one collide into one budget.
    assert guest_agent_id(_guest_key("https://sandbox.auth.world.org", "S")) != guest_agent_id(
        _guest_key("https://auth.world.org", "S")
    )


def test_a_live_agent_pass_token_yields_a_budget_key_end_to_end():
    #: The whole substitution, over a real socket: device flow -> validated
    #: token -> claims -> the key the chain would be asked about. `treasurer`
    #: is None because a public door accepts ANY verified human, which is the
    #: one argument that differs from `probe` and `enroll`.
    with serve(pending_polls=0, quiet=True, sub="A-REAL-LOOKING-SUBJECT") as fake:
        verdict, _ = _walk(fake, asked=(ORB,), accepted=(ORB,), treasurer=False)
        assert verdict.ok, verdict.reason
        c = verdict.claims
        assert c.sub == "A-REAL-LOOKING-SUBJECT"
        aid = guest_agent_id(_guest_key(c.iss, c.sub))
        assert len(aid) == 32
        #: And it is reproducible from the claims alone, which is what lets the
        #: chain be the authority rather than a database of ours.
        assert aid == guest_agent_id(_guest_key(c.iss, c.sub))


def test_a_refused_token_yields_no_key_at_all():
    #: The control. A budget key derived from an unvalidated token would be a
    #: budget issued to anyone who can reach the endpoint.
    with serve(pending_polls=0, quiet=True, advertised=(ORB,)) as fake:
        verdict, polled = _walk(fake, asked=(ORB_FACE,), accepted=(ORB_FACE,), treasurer=False)
        assert polled.kind == "stop"
        assert verdict is None, "no claims, so nothing to derive a key from"
