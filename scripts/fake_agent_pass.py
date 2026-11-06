#!/usr/bin/env python3
"""A local stand-in for World ID Agent Pass, so the orb device flow can run.

WHY THIS EXISTS. The validation half of the Agent Pass leg was already proven
offline: `float_rehearse.py` mints a genuine RS256 token from a locally
generated key and clears all nine rungs. But it builds `IdTokenValidator`
DIRECTLY, with `jwks=lambda: [jwk_of(key)]`, so `worldflow.py` -- discovery, the
essential-`acr` claims parameter, the device grant, the poll table -- had never
run against anything but `httpx.MockTransport` stubs in a test file. The `live`
rehearsal leg was a twelve-line unconditional refusal. So the single most
protocol-heavy file in the World track had no end-to-end witness at all.

This closes that with no credential: a real socket, speaking real OIDC, issuing
real RS256 tokens. The code it exercises is the SHIPPING code -- nothing is
injected and no production file changes -- because the issuer is reached the
only way World would be, through `ACR_WORLD_OIDC_ISSUER`.

WHAT IT PROVES, AND WHAT IT DOES NOT. It proves our half, end to end, including
every HTTP path. It proves NOTHING about World: no real orb, no real person, no
evidence that World's issuer would answer this way. The Agent Pass submission's
line is "what is synthetic is the issuer, not the validation", and that is
exactly the boundary here. **Never fill the debrief's live timing rows from
this.** They measure World's issuance and this is not it.

Stdlib only, on purpose: a fixture that needs a dependency added hours before a
freeze is a fixture that does not get used.

  from fake_agent_pass import serve
  with serve(client_id="my-client", sub="user-1") as fake:
      ...  # fake.issuer is http://127.0.0.1:<port>, fake.key signs its tokens
"""

from __future__ import annotations

import base64
import json
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

#: The two classes BOTH real issuers advertise. Read off live discovery on
#: 2026-11-05: production and sandbox agree, and neither lists the `selfie`
#: classes the step-up guide documents. Advertising exactly these keeps the
#: fake honest about the choice a real integration actually faces.
ORB = "https://world.org/oidc/acr/orb"
ORB_FACE = "https://world.org/oidc/acr/orb-face"

KID = "fake-agent-pass-1"


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def keypair():
    from cryptography.hazmat.primitives.asymmetric import rsa

    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def jwk_of(key, kid: str = KID) -> dict:
    """A JWK with a REAL modulus.

    The test router's JWKS is `{"kty": "RSA", "kid": "k1"}` with no `n` and no
    `e`, which is why those tests can only ever exercise the state machine:
    `_rsa_verifies` raises KeyError on the missing modulus and the signature
    rung refuses every token. Serving a real one is the whole join.
    """
    pub = key.public_key().public_numbers()

    def b(i: int) -> str:
        return _b64u(i.to_bytes((i.bit_length() + 7) // 8, "big"))

    return {"kty": "RSA", "kid": kid, "alg": "RS256", "n": b(pub.n), "e": b(pub.e)}


def mint(key, claims: dict, kid: str = KID) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    def enc(d: dict) -> str:
        return _b64u(json.dumps(d, separators=(",", ":")).encode())

    signed = f"{enc({'alg': 'RS256', 'typ': 'JWT', 'kid': kid})}.{enc(claims)}".encode()
    sig = key.sign(signed, padding.PKCS1v15(), hashes.SHA256())
    return f"{signed.decode()}.{_b64u(sig)}"


@dataclass
class Fake:
    """A running fake issuer. `issuer` is what ACR_WORLD_OIDC_ISSUER must be."""

    issuer: str
    key: object
    port: int
    #: Polls answered `authorization_pending` before approval. The caller owns
    #: the clock and `worldflow` floors the interval at 5s, so each pending
    #: poll costs five real seconds -- 0 for a fast rehearsal, 1 to put the
    #: poll table on the path.
    pending_polls: int = 1
    sub: str = "fake-agent-pass-subject"
    advertised: tuple[str, ...] = (ORB, ORB_FACE)
    #: Set to deny every approval, which is how the `access_denied` ambiguity
    #: gets reproduced on demand rather than waited for.
    deny: bool = False
    requests: list[str] = field(default_factory=list)
    _codes: dict = field(default_factory=dict, repr=False)
    _srv: object = field(default=None, repr=False)

    def jwks(self) -> dict:
        return {"keys": [jwk_of(self.key)]}

    def discovery(self) -> dict:
        #: `issuer` MUST be our own base URL: worldflow refuses when discovery's
        #: issuer differs from the configured one, which is the redirect hazard
        #: it exists to catch (and the reason the socket must be bound before
        #: this document can be built).
        return {
            "issuer": self.issuer,
            "jwks_uri": f"{self.issuer}/.well-known/jwks.json",
            "device_authorization_endpoint": f"{self.issuer}/api/v1/device_authorization",
            "token_endpoint": f"{self.issuer}/api/v1/token",
            "id_token_signing_alg_values_supported": ["RS256"],
            "acr_values_supported": list(self.advertised),
            "claims_parameter_supported": True,
            "grant_types_supported": ["urn:ietf:params:oauth:grant-type:device_code"],
            "scopes_supported": ["openid"],
        }


def _client_id_from(headers, body: dict) -> str:
    """The audience to mint for, taken from the request rather than configured.

    `client_secret_basic` is the portal default, so the id arrives
    form-urlencoded inside a Basic header; `post` puts it in the body. Reading
    it back means the token's `aud` matches whatever client the caller is
    configured with, so this works without being told.
    """
    auth = headers.get("authorization") or ""
    if auth.lower().startswith("basic "):
        try:
            raw = base64.b64decode(auth.split(None, 1)[1]).decode()
            return unquote(raw.split(":", 1)[0])
        except Exception:  # noqa: BLE001 - a malformed header is just absent
            pass
    return str((body.get("client_id") or [""])[0])


def _wanted_acr(body: dict) -> list[str]:
    """The essential `acr` values out of the OIDC `claims` parameter."""
    try:
        claims = json.loads((body.get("claims") or ["{}"])[0])
        return list(claims["id_token"]["acr"]["values"])
    except Exception:  # noqa: BLE001 - no essential claim is a valid request
        return []


def _handler(fake: Fake):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # noqa: ANN002 - quiet; the caller narrates
            return

        def _send(self, code: int, payload: dict) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            fake.requests.append(f"GET {self.path}")
            if self.path.endswith("openid-configuration"):
                return self._send(200, fake.discovery())
            if self.path.endswith("jwks.json"):
                return self._send(200, fake.jwks())
            return self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            fake.requests.append(f"POST {self.path}")
            n = int(self.headers.get("content-length") or 0)
            body = parse_qs(self.rfile.read(n).decode()) if n else {}

            if "device_authorization" in self.path:
                wanted = _wanted_acr(body)
                code = f"dev-{len(fake._codes) + 1}-{int(time.time())}"
                fake._codes[code] = {
                    "left": fake.pending_polls,
                    "wanted": wanted,
                    "aud": _client_id_from(self.headers, body),
                }
                return self._send(
                    200,
                    {
                        "device_code": code,
                        "user_code": f"FAKE-{len(fake._codes):03d}",
                        "verification_uri": f"{fake.issuer}/device",
                        "expires_in": 600,
                        #: worldflow floors this at DEFAULT_INTERVAL_S anyway.
                        "interval": 1,
                    },
                )

            if self.path.endswith("/token"):
                code = str((body.get("device_code") or [""])[0])
                st = fake._codes.get(code)
                if st is None:
                    return self._send(400, {"error": "invalid_grant"})
                if st["left"] > 0:
                    st["left"] -= 1
                    return self._send(400, {"error": "authorization_pending"})
                if fake.deny:
                    return self._send(400, {"error": "access_denied"})

                #: THE AMBIGUITY, reproduced faithfully. An essential claim
                #: naming a class we do not advertise is not a preference we can
                #: ignore -- it is a requirement we cannot meet -- and the only
                #: answer OIDC gives us is the same `access_denied` a human
                #: refusal produces. A backend cannot tell them apart, which is
                #: the debrief's §2 complaint and now a testable fact.
                usable = [a for a in st["wanted"] if a in fake.advertised]
                if st["wanted"] and not usable:
                    return self._send(400, {"error": "access_denied"})

                acr = usable[0] if usable else ORB
                now = int(time.time())
                return self._send(
                    200,
                    {
                        "token_type": "Bearer",
                        "expires_in": 600,
                        "id_token": mint(
                            fake.key,
                            {
                                "iss": fake.issuer,
                                "sub": fake.sub,
                                "aud": st["aud"],
                                "exp": now + 600,
                                "iat": now,
                                "acr": acr,
                                #: `face` only when a face class was achieved,
                                #: because `amr` is what the policy gate reads.
                                "amr": ["pop", "face", "user"]
                                if acr == ORB_FACE
                                else ["pop"],
                                #: AFTER the checkpoint opened, which is what
                                #: `auth_time` freshness means here. A device
                                #: token carries no `nonce` by spec, so this is
                                #: the only freshness signal there is.
                                "auth_time": now,
                            },
                        ),
                    },
                )

            return self._send(404, {"error": "not_found"})

    return H


@contextmanager
def serve(*, pending_polls: int = 1, sub: str = "fake-agent-pass-subject",
          advertised: tuple[str, ...] = (ORB, ORB_FACE), deny: bool = False, quiet: bool = False):
    """Run the fake on an ephemeral port until the block exits."""
    #: PORT 0, never a fixed one. Parallel sessions share this machine's ports,
    #: and a fixed port is how one session's fixture silently answers another
    #: session's run.
    srv = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = srv.server_address[1]
    fake = Fake(
        issuer=f"http://127.0.0.1:{port}",
        key=keypair(),
        port=port,
        pending_polls=pending_polls,
        sub=sub,
        advertised=advertised,
        deny=deny,
    )
    srv.RequestHandlerClass = _handler(fake)
    fake._srv = srv
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    if not quiet:
        print(f"  ·· a LOCAL FAKE Agent Pass issuer is listening on {fake.issuer}")
        print("  ·· it is not World. It proves our half of the flow, nothing about theirs.")
    try:
        yield fake
    finally:
        srv.shutdown()
        srv.server_close()
        t.join(timeout=5)


if __name__ == "__main__":
    #: Standalone: stand it up and talk to it, so the fixture itself has a
    #: witness that does not depend on the rest of the repo.
    import httpx

    with serve(pending_polls=1) as f:
        d = httpx.get(f"{f.issuer}/.well-known/openid-configuration").json()
        assert d["issuer"] == f.issuer, "discovery must echo its own base url"
        assert ORB in d["acr_values_supported"]
        k = httpx.get(d["jwks_uri"]).json()["keys"][0]
        assert k["n"] and k["e"], "a JWKS without a modulus verifies nothing"
        print(f"  ok  discovery and a real JWKS ({len(k['n'])} b64 chars of modulus)")
        print(f"  ok  {len(f.requests)} requests served")
