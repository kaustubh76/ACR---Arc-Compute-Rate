"""The Agent Pass validation ladder, against locally signed tokens.

No network, no World credential, no chain. World's own testing guide asks for
exactly this: "Use local signed fixtures to exercise validation failures and
application policy without requiring a person for every test." Every rung in
`REASONS` gets its own test, and each one must fail for ITS reason — a suite
where three different forgeries all report `bad_signature` proves only that
something was rejected, not that the ladder works.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from index_api.worldauth import (
    REASONS,
    Claims,
    IdTokenValidator,
    treasurer_binding,
    verify_rs256,
)

ISS = "https://auth.world.org"
AUD = "client_abc"
ORB = "https://world.org/oidc/acr/orb"
SELFIE = "https://world.org/oidc/acr/selfie"
SUB = "world-subject-0001"
OPENED = 1_800_000_000.0

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _jwk(key: rsa.RSAPrivateKey, kid: str = "k1") -> dict:
    n = key.public_key().public_numbers().n
    e = key.public_key().public_numbers().e
    return {
        "kty": "RSA",
        "kid": kid,
        "n": _b64(n.to_bytes((n.bit_length() + 7) // 8, "big")),
        "e": _b64(e.to_bytes((e.bit_length() + 7) // 8, "big")),
    }


def _token(
    claims: dict, *, key: rsa.RSAPrivateKey = _KEY, alg: str = "RS256", kid: str = "k1"
) -> str:
    head = _b64(json.dumps({"alg": alg, "typ": "JWT", "kid": kid}).encode())
    body = _b64(json.dumps(claims).encode())
    signed = f"{head}.{body}".encode()
    if alg == "none":
        return f"{head}.{body}."
    if alg == "HS256":
        #: The classic confusion: sign with the RSA public key as an HMAC secret
        #: and hope the verifier reads `alg` from the token it is checking.
        pub = key.public_key().public_numbers().n
        mac = hmac.new(str(pub).encode(), signed, hashlib.sha256).digest()
        return f"{head}.{body}.{_b64(mac)}"
    sig = key.sign(signed, padding.PKCS1v15(), hashes.SHA256())
    return f"{head}.{body}.{_b64(sig)}"


def _claims(**over) -> dict:
    base = {
        "iss": ISS,
        "sub": SUB,
        "aud": AUD,
        "exp": int(OPENED) + 600,
        "iat": int(OPENED),
        "auth_time": OPENED + 30,
        "acr": ORB,
        "amr": ["pop"],
    }
    base.update(over)
    return base


def _validator(**over) -> IdTokenValidator:
    kw = {
        "issuer": ISS,
        "audience": AUD,
        "accepted_acr": (ORB, SELFIE),
        "jwks": lambda: [_jwk(_KEY)],
        "treasurer": (ISS, SUB),
    }
    kw.update(over)
    return IdTokenValidator(**kw)


def _check(token: str, *, validator: IdTokenValidator | None = None, now: float | None = None):
    v = validator or _validator()
    return v.check(token, opened_at=OPENED, now=OPENED + 60 if now is None else now)


# --- the happy path ---------------------------------------------------------


def test_a_valid_token_passes():
    verdict = _check(_token(_claims()))
    assert verdict.ok, verdict.reason
    assert verdict.reason == "ok"
    assert isinstance(verdict.claims, Claims)
    assert verdict.claims.sub == SUB
    assert verdict.claims.acr == ORB


def test_an_audience_array_is_accepted_because_oidc_allows_one():
    verdict = _check(_token(_claims(aud=["someone-else", AUD])))
    assert verdict.ok, verdict.reason


def test_a_token_whose_kid_is_unknown_still_verifies_against_the_live_keys():
    #: Key rotation must not read as forgery: an unmatched `kid` falls back to
    #: trying every published key, and only a failed signature refuses.
    verdict = _check(_token(_claims(), kid="rotated-away"))
    assert verdict.ok, verdict.reason


# --- the ladder, rung by rung ----------------------------------------------


def test_a_malformed_token_is_refused():
    assert _check("not.a.jwt").reason == "malformed_token"
    assert _check("onlyonesegment").reason == "malformed_token"


def test_a_signature_from_another_key_is_refused():
    assert _check(_token(_claims(), key=_OTHER)).reason == "bad_signature"


def test_an_unsigned_token_is_refused():
    #: `alg: none` must never be honoured, however well-formed the claims are.
    assert _check(_token(_claims(), alg="none")).reason == "bad_signature"


def test_a_token_signed_with_the_public_key_as_an_hmac_secret_is_refused():
    assert _check(_token(_claims(), alg="HS256")).reason == "bad_signature"


def test_the_wrong_issuer_is_refused():
    assert _check(_token(_claims(iss="https://evil.example"))).reason == "wrong_issuer"


def test_a_token_minted_for_another_client_is_refused():
    assert _check(_token(_claims(aud="someone-elses-client"))).reason == "wrong_audience"


def test_an_expired_token_is_refused():
    assert _check(_token(_claims(exp=int(OPENED) - 1))).reason == "expired"


def test_an_assurance_class_we_do_not_accept_is_refused():
    orb_only = _validator(accepted_acr=(ORB,))
    token = _token(_claims(acr=SELFIE))
    assert _check(token, validator=orb_only).reason == "assurance_not_accepted"


def test_a_token_with_no_assurance_class_at_all_is_refused():
    claims = _claims()
    del claims["acr"]
    assert _check(_token(claims)).reason == "assurance_not_accepted"


def test_a_passkey_is_refused_where_the_checkpoint_requires_a_live_face():
    #: World: only the passkey value asserts MFA, and it "does not assert a
    #: fresh World proof" — so a policy change must not be clearable with one.
    policy = _validator(require_amr=("face",), forbid_amr=("mfa",))
    token = _token(_claims(amr=["pop", "user", "mfa"]))
    assert _check(token, validator=policy).reason == "amr_not_accepted"


def test_a_plain_proof_is_refused_where_a_face_is_required():
    policy = _validator(require_amr=("face",), forbid_amr=("mfa",))
    assert _check(_token(_claims(amr=["pop"])), validator=policy).reason == "amr_not_accepted"


def test_a_face_check_clears_a_policy_checkpoint():
    policy = _validator(require_amr=("face",), forbid_amr=("mfa",))
    token = _token(_claims(amr=["pop", "face", "user"]))
    assert _check(token, validator=policy).ok


def test_an_authentication_from_before_we_asked_is_refused():
    #: The whole point of a checkpoint: a token that is valid, unexpired and
    #: from the right human is still not an approval of THIS payment if the
    #: human authenticated before we parked it.
    token = _token(_claims(auth_time=OPENED - 3600))
    assert _check(token).reason == "auth_time_outside_window"


def test_an_authentication_dated_in_the_future_is_refused():
    token = _token(_claims(auth_time=OPENED + 7200))
    assert _check(token).reason == "auth_time_outside_window"


def test_a_token_with_no_auth_time_is_refused():
    claims = _claims()
    del claims["auth_time"]
    assert _check(_token(claims)).reason == "auth_time_outside_window"


def test_another_human_is_refused_however_valid_their_token():
    token = _token(_claims(sub="somebody-elses-subject"))
    assert _check(token).reason == "not_the_enrolled_treasurer"


def test_an_unenrolled_validator_accepts_any_subject_so_enrollment_can_read_one():
    #: Enrollment is the one flow with no binding yet — it exists to learn the
    #: (iss, sub) that every later approval is held to.
    verdict = _check(
        _token(_claims(sub="first-time-we-have-seen-this")), validator=_validator(treasurer=None)
    )
    assert verdict.ok
    assert verdict.claims is not None and verdict.claims.sub == "first-time-we-have-seen-this"


# --- properties of the ladder itself ---------------------------------------


def test_the_reason_is_the_first_rung_that_failed_not_the_last():
    #: Wrong issuer AND wrong audience AND expired AND wrong class AND wrong
    #: human. The report must name the issuer, the rung closest to the
    #: signature, because that is the one whose fix unblocks the next.
    token = _token(
        _claims(iss="https://evil.example", aud="other", exp=int(OPENED) - 1, acr="x", sub="other"),
    )
    assert _check(token).reason == "wrong_issuer"


def test_every_named_reason_is_reachable():
    #: A reason no fixture can produce is a reason that will never be seen in
    #: production either, and a ladder with dead rungs is a ladder nobody can
    #: trust the shape of.
    seen = {
        _check("not.a.jwt").reason,
        _check(_token(_claims(), key=_OTHER)).reason,
        _check(_token(_claims(iss="https://evil.example"))).reason,
        _check(_token(_claims(aud="other"))).reason,
        _check(_token(_claims(exp=int(OPENED) - 1))).reason,
        _check(_token(_claims(acr="nope"))).reason,
        _check(
            _token(_claims(amr=["pop", "user", "mfa"])),
            validator=_validator(forbid_amr=("mfa",)),
        ).reason,
        _check(_token(_claims(auth_time=OPENED - 3600))).reason,
        _check(_token(_claims(sub="other"))).reason,
    }
    assert seen == set(REASONS)


def test_a_validator_that_accepts_no_assurance_class_refuses_to_exist():
    with pytest.raises(ValueError, match="accepts nothing"):
        _validator(accepted_acr=())


def test_verify_rs256_refuses_an_empty_key_set():
    with pytest.raises(ValueError, match="bad_signature"):
        verify_rs256(_token(_claims()), [])


# --- the on-chain binding ---------------------------------------------------


def test_the_binding_is_stable():
    assert treasurer_binding(ISS, SUB) == treasurer_binding(ISS, SUB)
    assert treasurer_binding(ISS, SUB).startswith("0x")
    assert len(treasurer_binding(ISS, SUB)) == 66


def test_the_boundary_between_issuer_and_subject_cannot_be_moved():
    #: Concatenating without a separator would make ("ab","c") and ("a","bc")
    #: the same human on chain. `setTreasurerBinding` is one-shot, so this is
    #: not a bug you patch — it is a vault you redeploy.
    assert treasurer_binding("ab", "c") != treasurer_binding("a", "bc")


def test_a_binding_needs_both_halves():
    for iss, sub in (("", SUB), (ISS, ""), ("", "")):
        with pytest.raises(ValueError, match="both an issuer and a subject"):
            treasurer_binding(iss, sub)


def test_the_claims_carry_their_own_binding():
    verdict = _check(_token(_claims()))
    assert verdict.claims is not None
    assert verdict.claims.binding() == treasurer_binding(ISS, SUB)
