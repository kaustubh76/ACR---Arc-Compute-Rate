"""World ID Agent Pass — deciding whether a human really authorised this spend.

WHAT THIS IS NOT. It is not a login. Nothing here creates a session, and a valid
token buys no standing beyond the single parked payment it was demanded for. It
is also not a signature over the payment: World's device profile says so in as
many words — "binding_message or action terms: Unsupported. They are not
displayed on the approval page or signed into the ID token. The human sees the
requester and user code." So the token proves *who authenticated, how, and
when*. It never proves *what they agreed to*.

WHAT IT IS. The one place that turns an ID token into a yes or a named no. Every
rung below is a separate refusal with its own reason, in a fixed order, because
"the approval failed" is not an answer an operator can act on: a stale
`auth_time` means the human replayed an old session, a disallowed `acr` means
the account is not verified enough, and a `sub` mismatch means the wrong person
approved — three different problems with three different fixes.

Where the binding lives. `FloatVault._consumeApproval` reads the contract-level
`treasurerBinding`, not a per-checkpoint value, so the chain can only assert
"the enrolled treasurer's identity hashes to this". It cannot see freshness, the
assurance class, or which verification happened. **All of that is enforced
here.** Say that precisely when claiming the property: the chain enforces *what*
was approved and that it is single-use; this module enforces *who* approved it
and *that they did it just now*.

Offline by construction. The JWKS arrives as an injected callable, so the whole
ladder is exercised against locally signed fixtures with no network and no World
credential — which is also what World's own testing guide prescribes: "Use local
signed fixtures to exercise validation failures and application policy without
requiring a person for every test."
"""

from __future__ import annotations

import base64
import json
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

log = logging.getLogger("index_api.worldauth")

#: The only signing algorithm World IdP advertises
#: (`id_token_signing_alg_values_supported: ["RS256"]`). Pinned rather than read
#: from the token, because trusting the token's own `alg` is how `none` and the
#: HS256-with-the-public-key trick get in.
ALG = "RS256"

#: The refusals, in the order they are checked. A caller may rely on this order:
#: the reason reported is the FIRST rung that failed, never the last, so a token
#: with three problems names the one closest to the signature.
REASONS: tuple[str, ...] = (
    "malformed_token",
    "bad_signature",
    "wrong_issuer",
    "wrong_audience",
    "expired",
    "assurance_not_accepted",
    "amr_not_accepted",
    "auth_time_outside_window",
    "not_the_enrolled_treasurer",
)

#: Prefix for the on-chain treasurer binding. Domain-separated like every other
#: hash in this repo (`acr.decision::`, `acr.category::`) so a binding can never
#: collide with a value hashed for another purpose.
BINDING_PREFIX = b"acr.treasurer::"

#: Separates issuer from subject inside the binding preimage. A unit separator,
#: not a colon or a slash: neither may appear in it, so no pair of distinct
#: (iss, sub) can be made to hash the same way by moving the boundary.
BINDING_SEP = b"\x1f"


def treasurer_binding(iss: str, sub: str) -> str:
    """The `bytes32` that `FloatVault.setTreasurerBinding` is given, as 0x hex.

    Written down here because the vault takes an opaque `bytes32` and never
    defines its preimage, and because `setTreasurerBinding` can only be called
    **once** from zero: an encoding the signer and the chain disagree about is
    not a bug you fix, it is a vault you redeploy.
    """
    from eth_utils import keccak

    if not iss or not sub:
        raise ValueError("a treasurer binding needs both an issuer and a subject")
    return "0x" + keccak(BINDING_PREFIX + iss.encode() + BINDING_SEP + sub.encode()).hex()


@dataclass(frozen=True)
class Claims:
    """The claims this module is willing to act on. Deliberately not the raw token."""

    iss: str
    sub: str
    aud: tuple[str, ...]
    exp: int
    acr: str
    amr: tuple[str, ...]
    auth_time: float

    def binding(self) -> str:
        return treasurer_binding(self.iss, self.sub)


@dataclass(frozen=True)
class Verdict:
    """A yes with claims, or a no with a reason from `REASONS`. Never both."""

    ok: bool
    reason: str
    claims: Claims | None = None

    @property
    def refused(self) -> bool:
        return not self.ok


def _b64url(seg: str) -> bytes:
    #: JWT segments carry no padding; `urlsafe_b64decode` insists on it.
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def verify_rs256(token: str, jwks: Sequence[dict]) -> dict:
    """Verify an RS256 JWT against a JWKS and return its payload.

    Raises `ValueError` with a `REASONS` member on any failure. The signature is
    checked over the exact bytes the issuer signed — the raw
    `header.payload` substring, never a re-serialisation of the decoded JSON,
    because re-encoding may not reproduce the original byte for byte.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed_token")
    head_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url(head_b64))
        payload = json.loads(_b64url(payload_b64))
        signature = _b64url(sig_b64)
    except Exception as exc:  # noqa: BLE001 - any decode failure is one refusal
        raise ValueError("malformed_token") from exc
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise ValueError("malformed_token")

    #: Pinned, not read. `alg: none` and HS256-signed-with-the-RSA-public-key are
    #: the two oldest JWT forgeries there are, and both arrive as a token whose
    #: header asks politely to be verified differently.
    if header.get("alg") != ALG:
        raise ValueError("bad_signature")

    kid = header.get("kid")
    candidates = [k for k in jwks if kid is None or k.get("kid") == kid] or list(jwks)
    signed = f"{head_b64}.{payload_b64}".encode()
    for jwk in candidates:
        try:
            if not _rsa_verifies(jwk, signature, signed):
                continue
        except Exception:  # noqa: BLE001 - a malformed key is not a valid signature
            continue
        return payload
    raise ValueError("bad_signature")


def _rsa_verifies(jwk: dict, signature: bytes, signed: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    if jwk.get("kty") != "RSA":
        return False
    n = int.from_bytes(_b64url(jwk["n"]), "big")
    e = int.from_bytes(_b64url(jwk["e"]), "big")
    key = rsa.RSAPublicNumbers(e, n).public_key()
    try:
        #: RS256 is RSASSA-PKCS1-v1_5 over SHA-256, not PSS.
        key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        return False
    return True


class IdTokenValidator:
    """The ladder. One instance per (issuer, client), reusable across checkpoints."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        accepted_acr: Sequence[str],
        jwks: Callable[[], Sequence[dict]],
        require_amr: Sequence[str] = (),
        forbid_amr: Sequence[str] = (),
        treasurer: tuple[str, str] | None = None,
        skew_s: float = 30.0,
    ) -> None:
        if not issuer or not audience:
            raise ValueError("a validator needs both an issuer and an audience")
        if not accepted_acr:
            #: An empty allow-list would accept every class including none at
            #: all, which is the opposite of what an assurance check is for.
            raise ValueError("a validator with no accepted assurance class accepts nothing")
        self.issuer = issuer
        self.audience = audience
        self.accepted_acr = tuple(accepted_acr)
        self.require_amr = tuple(require_amr)
        self.forbid_amr = tuple(forbid_amr)
        self.treasurer = treasurer
        self.skew_s = float(skew_s)
        self._jwks = jwks

    def check(self, token: str, *, opened_at: float, now: float | None = None) -> Verdict:
        """Run every rung in `REASONS` order and return the first failure."""
        at = time.time() if now is None else float(now)

        try:
            payload = verify_rs256(token, self._jwks())
        except ValueError as exc:
            return Verdict(False, str(exc))

        if payload.get("iss") != self.issuer:
            return Verdict(False, "wrong_issuer")

        raw_aud = payload.get("aud")
        aud = (raw_aud,) if isinstance(raw_aud, str) else tuple(raw_aud or ())
        if self.audience not in aud:
            return Verdict(False, "wrong_audience")

        exp = payload.get("exp")
        if not isinstance(exp, int | float) or at > float(exp) + self.skew_s:
            return Verdict(False, "expired")

        acr = payload.get("acr")
        if not isinstance(acr, str) or acr not in self.accepted_acr:
            return Verdict(False, "assurance_not_accepted")

        amr = tuple(payload.get("amr") or ())
        #: World documents exactly three shapes: `["pop"]`, `["pop","face","user"]`
        #: and `["pop","user","mfa"]`, and says only the passkey value asserts
        #: MFA and that it "does not assert a fresh World proof". That is why a
        #: policy-class checkpoint forbids `mfa` and requires `face`.
        if any(f in amr for f in self.forbid_amr):
            return Verdict(False, "amr_not_accepted")
        if any(r not in amr for r in self.require_amr):
            return Verdict(False, "amr_not_accepted")

        auth_time = payload.get("auth_time")
        if not isinstance(auth_time, int | float):
            #: The device profile makes `auth_time` required, and without it
            #: there is no freshness claim left to check.
            return Verdict(False, "auth_time_outside_window")
        auth_time = float(auth_time)
        #: Fresh means "after we asked", not "recently". A token minted before
        #: the checkpoint opened may be perfectly valid and still be the human
        #: approving something else, earlier.
        if auth_time < opened_at - self.skew_s or auth_time > at + self.skew_s:
            return Verdict(False, "auth_time_outside_window")

        iss, sub = str(payload["iss"]), str(payload.get("sub") or "")
        if not sub:
            return Verdict(False, "not_the_enrolled_treasurer")
        if self.treasurer is not None and (iss, sub) != self.treasurer:
            return Verdict(False, "not_the_enrolled_treasurer")

        return Verdict(
            True,
            "ok",
            Claims(
                iss=iss,
                sub=sub,
                aud=aud,
                exp=int(exp),
                acr=acr,
                amr=amr,
                auth_time=auth_time,
            ),
        )
