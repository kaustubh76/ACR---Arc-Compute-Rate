"""The World ID device authorization grant — asking a human, from a headless service.

WHY THIS GRANT. World's own start-here table routes us here: "Authenticate a CLI
or client without a browser callback -> Device Authorization Grant", and the
step-up guide names it for agents: "For headless clients, follow the Device
Authorization Grant." The press has no browser and the agent must never hold a
credential, so this is the only shape that fits.

THE POLL IS A TABLE, NOT A BRANCH. Every outcome below is quoted from World's
device profile, and three of them are the kind of thing a hand-written retry
loop gets wrong in a way that only shows up on stage:

  * HTTP 503 is "Temporary unavailability, never approval. End this attempt."
    An unreachable identity provider must never read as a yes.
  * HTTP 429 "can end the attempt; `Retry-After` does not override the stop
    rules" -- so the header is recorded and then ignored.
  * `slow_down` means "Add five seconds to all later intervals", not to the
    next one. A loop that widens once and springs back gets rate-limited into
    an expiry.

And the docs warn: "Do not automatically restart authorization in a loop after
a failed attempt. If you cannot tell whether a start request succeeded, it may
leave an unused attempt until expiry." So nothing here retries a start.

`access_denied` IS AMBIGUOUS AND WE SAY SO. World returns it when the human
declines, when an essential `acr` cannot be met, and when `claims.id_token.sub`
mismatches. Three different problems, one code, and the provider cannot tell
them apart. Reporting it as "the human denied it" would be a guess dressed as
evidence, so the reason is named `refused_or_assurance_unmet` and the sentence
spells out all three.

THE DEVICE CODE IS A SECRET. It is the bearer of the whole approval: anyone
holding it can redeem the token. It stays in `Started.device_code`, never in a
log line, never in a public view, and never in a response an agent can read.
"""

from __future__ import annotations

import json
import logging
from base64 import b64encode
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx

log = logging.getLogger("index_api.worldflow")

#: The grant's own name, per RFC 8628.
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

#: World advertises only `openid`; there is nothing else to ask for.
SCOPE = "openid"

#: Floor for the poll interval when the provider omits or zeroes it. RFC 8628
#: says 5 seconds is the default, and a zero would busy-loop the token endpoint
#: straight into the rate limit that `slow_down` exists to warn about.
DEFAULT_INTERVAL_S = 5

#: What `slow_down` adds, per World's device profile: "Add five seconds to all
#: later intervals."
SLOW_DOWN_STEP_S = 5

#: A device code "expires 20 minutes after creation, even if approval occurs
#: near expiry, and can be redeemed once." Our own checkpoint TTL is shorter;
#: this is the ceiling no configuration may exceed.
MAX_DEVICE_CODE_LIFETIME_S = 20 * 60

#: Token-endpoint error codes that end the attempt, and the named reason each
#: becomes. Anything not listed also stops -- an unrecognised error is not a
#: reason to keep asking.
STOP_REASONS: dict[str, str] = {
    "access_denied": "refused_or_assurance_unmet",
    "expired_token": "device_code_expired",
    "invalid_grant": "device_code_rejected",
}

#: The sentence an operator reads. Written out because a reason code in a
#: dashboard is only as useful as the sentence somebody wrote for it.
SENTENCES: dict[str, str] = {
    "refused_or_assurance_unmet": (
        "the human declined, or the requested assurance class was not met, or the identity was "
        "not the enrolled treasurer. World returns one code for all three and cannot tell them apart"
    ),
    "device_code_expired": "the device code lapsed before anyone approved it",
    "device_code_rejected": "the identity provider rejected this device code",
    "provider_unavailable": (
        "World ID was unreachable. Unavailability is never an approval, so the attempt ended "
        "and nothing moved"
    ),
    "rate_limited": "World ID rate-limited this client, which ends the attempt",
    "provider_error": "World ID answered in a way this client does not recognise",
}


def essential_acr_claims(acr_values: tuple[str, ...] | list[str]) -> str:
    """The OIDC `claims` parameter that makes an assurance class a REQUIREMENT.

    A bare `acr_values` is only a preference -- World says so: "Unsupported
    values do not force an error; validate the achieved `acr` yourself." The
    enforceable form is an essential claim, and it takes a `values` ARRAY. The
    singular `value` spelling is a different member of the OIDC claims syntax
    and asking with it would silently request nothing.
    """
    values = [v for v in acr_values if v]
    if not values:
        raise ValueError("an essential assurance claim needs at least one class")
    return json.dumps({"id_token": {"acr": {"essential": True, "values": values}}})


@dataclass(frozen=True)
class Started:
    """A live device authorization. `device_code` is a bearer secret."""

    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int
    verification_uri_complete: str | None = None

    def public(self) -> dict:
        """What a browser, an agent or a log may see. Never the device code."""
        return {
            "user_code": self.user_code,
            "verification_uri": self.verification_uri_complete or self.verification_uri,
            "expires_in": self.expires_in,
        }


@dataclass(frozen=True)
class Polled:
    """One poll's outcome. `kind` drives the worker; `reason` is the evidence."""

    kind: str  # "token" | "pending" | "slow_down" | "stop"
    reason: str = ""
    id_token: str | None = None
    retry_after: float | None = None

    @property
    def sentence(self) -> str:
        return SENTENCES.get(self.reason, self.reason)


@dataclass
class DeviceFlow:
    """A device-grant client for one registered World IdP application."""

    issuer: str
    client_id: str
    client_secret: str
    #: `client_secret_basic` is the portal default. The method is fixed for a
    #: client's lifetime -- "register a new client to switch methods" -- so it
    #: is configuration, never a guess, and never a fallback chain that would
    #: put the secret in a body the operator did not choose to put it in.
    auth_method: str = "basic"
    timeout_s: float = 15.0
    transport: httpx.BaseTransport | None = None
    _disc: dict | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not self.issuer or not self.client_id or not self.client_secret:
            raise ValueError("a device flow needs an issuer, a client id and a client secret")
        if self.auth_method not in ("basic", "post"):
            raise ValueError("auth_method must be 'basic' or 'post'")

    # --- plumbing -----------------------------------------------------------

    def _client(self) -> httpx.Client:
        kw = {"timeout": self.timeout_s}
        if self.transport is not None:
            kw["transport"] = self.transport
        return httpx.Client(**kw)

    def _auth(self) -> tuple[dict, dict]:
        """Returns (headers, extra_body_fields) for the chosen client auth."""
        if self.auth_method == "basic":
            #: RFC 6749 wants both halves form-urlencoded before base64.
            raw = f"{quote(self.client_id, safe='')}:{quote(self.client_secret, safe='')}"
            return {"authorization": "Basic " + b64encode(raw.encode()).decode()}, {}
        return {}, {"client_id": self.client_id, "client_secret": self.client_secret}

    def discovery(self) -> dict:
        if self._disc is not None:
            return self._disc
        url = f"{self.issuer.rstrip('/')}/.well-known/openid-configuration"
        with self._client() as c:
            r = c.get(url, headers={"accept": "application/json"})
        r.raise_for_status()
        disc = r.json()
        #: The issuer in the document must be the issuer we asked, or a
        #: redirect has quietly moved us to somebody else's identity provider.
        if disc.get("issuer") != self.issuer:
            raise ValueError(
                f"discovery issuer {disc.get('issuer')!r} is not the configured {self.issuer!r}"
            )
        self._disc = disc
        return disc

    def jwks(self) -> list[dict]:
        """The signing keys, for `worldauth.IdTokenValidator`."""
        uri = self.discovery().get("jwks_uri") or f"{self.issuer.rstrip('/')}/.well-known/jwks.json"
        with self._client() as c:
            r = c.get(uri, headers={"accept": "application/json"})
        r.raise_for_status()
        return list(r.json().get("keys") or [])

    def supported_acr(self) -> tuple[str, ...]:
        return tuple(self.discovery().get("acr_values_supported") or ())

    # --- the flow -----------------------------------------------------------

    def start(self, acr_values: tuple[str, ...] | list[str]) -> Started:
        """Open a device authorization. Never retried -- see the module note."""
        disc = self.discovery()
        endpoint = disc.get("device_authorization_endpoint")
        if not endpoint:
            raise ValueError("this issuer advertises no device authorization endpoint")
        headers, extra = self._auth()
        body = {"scope": SCOPE, "claims": essential_acr_claims(acr_values), **extra}
        with self._client() as c:
            r = c.post(
                endpoint,
                data=body,
                headers={**headers, "content-type": "application/x-www-form-urlencoded"},
            )
        if r.status_code >= 400:
            #: Never log the body: a start failure can echo the request.
            raise ValueError(f"device_authorization refused with HTTP {r.status_code}")
        j = r.json()
        for required in ("device_code", "user_code", "verification_uri"):
            if not j.get(required):
                raise ValueError(f"device_authorization answered without {required}")
        expires = int(j.get("expires_in") or MAX_DEVICE_CODE_LIFETIME_S)
        return Started(
            device_code=str(j["device_code"]),
            user_code=str(j["user_code"]),
            verification_uri=str(j["verification_uri"]),
            verification_uri_complete=(
                str(j["verification_uri_complete"]) if j.get("verification_uri_complete") else None
            ),
            expires_in=min(expires, MAX_DEVICE_CODE_LIFETIME_S),
            interval=max(int(j.get("interval") or DEFAULT_INTERVAL_S), DEFAULT_INTERVAL_S),
        )

    def poll_once(self, device_code: str) -> Polled:
        """One poll. The caller owns the clock; this owns the interpretation."""
        endpoint = self.discovery().get("token_endpoint")
        if not endpoint:
            raise ValueError("this issuer advertises no token endpoint")
        headers, extra = self._auth()
        with self._client() as c:
            r = c.post(
                endpoint,
                data={"grant_type": DEVICE_GRANT, "device_code": device_code, **extra},
                headers={**headers, "content-type": "application/x-www-form-urlencoded"},
            )

        #: Checked before the body is even parsed: an unavailable provider has
        #: no opinion about this approval, and a 503 with a misleading body must
        #: not be able to express one.
        if r.status_code == 503:
            return Polled("stop", "provider_unavailable")
        if r.status_code == 429:
            retry = r.headers.get("retry-after")
            return Polled(
                "stop",
                "rate_limited",
                retry_after=float(retry) if (retry or "").strip().isdigit() else None,
            )

        try:
            j = r.json()
        except Exception:  # noqa: BLE001 - an unparseable answer is one outcome
            j = {}
        if not isinstance(j, dict):
            j = {}

        if r.status_code < 400 and j.get("id_token"):
            return Polled("token", "ok", id_token=str(j["id_token"]))

        err = str(j.get("error") or "")
        if err == "authorization_pending":
            return Polled("pending", "authorization_pending")
        if err == "slow_down":
            return Polled("slow_down", "slow_down")
        if err in STOP_REASONS:
            return Polled("stop", STOP_REASONS[err])
        #: Includes a 200 with no `id_token`: an answer we cannot read is not an
        #: approval, and continuing to poll would only burn the attempt.
        return Polled("stop", "provider_error")


def widen(interval: int, polled: Polled) -> int:
    """Apply `slow_down` to ALL later intervals, which is what the docs ask."""
    return interval + SLOW_DOWN_STEP_S if polled.kind == "slow_down" else interval
