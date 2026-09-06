"""AgentKit human proofs — the authorization that makes a fleet view safe to serve.

WHAT THIS IS NOT. It is not a paywall. `/tca/{payer}` is already ungated, on the
principle that a benchmark nobody can check for free is a benchmark nobody
checks, and a proof here buys no data that a caller could not already fetch one
wallet at a time.

WHAT IT IS. `/tca/human` answers "what did MY agents pay, across all of them" —
and the only way to ask that without a proof would be to pass a cluster id, which
would let anyone enumerate a stranger's entire wallet fleet from a public
endpoint. The proof is what stops the aggregation being a privacy leak. That is a
real access-control property and it is the one to claim: present no proof and the
answer is 401; present a proof and the answer is your own union; there is no
request shape that returns somebody else's.

The nullifier never leaves this module. A verified proof yields a cluster id —
`keccak256(nullifier ‖ salt ‖ window)` — and everything downstream works from
that, so the wallet set exists for the duration of one query and is never held.

Mirrors `x402.py` deliberately: same challenge/verify seam, same module
singleton, same fail-closed discipline, so one reviewer's understanding covers
both gates.
"""

from __future__ import annotations

import base64
import json
import logging
import secrets
import time
from abc import ABC, abstractmethod
from collections import OrderedDict
from dataclasses import dataclass

from acr_core import get_settings
from acr_oracle_client.humanid import cluster_id, current_window, salt_commitment
from fastapi import Header, HTTPException, Request

log = logging.getLogger("index_api.humanid")

#: The header a caller presents a proof in, and the one a challenge names.
PROOF_HEADER = "HUMAN-PROOF"
CHALLENGE_HEADER = "HUMAN-PROOF-CHALLENGE"

#: How long a challenge nonce stays spendable. Short, because the only thing it
#: has to survive is one round trip.
NONCE_TTL_S = 300.0
_MAX_NONCES = 4096


def mask(nullifier: str) -> str:
    """A nullifier, rendered so a log line cannot deanonymise anyone.

    Logs are read on stream, pasted into issues and shown on stage. The last
    three characters are enough to correlate two lines in one session and not
    enough to be anybody's identifier. Same instinct as `_short_addr` for
    wallets, applied to the value that actually matters.
    """
    tail = nullifier[-3:] if len(nullifier) >= 3 else "?"
    return f"••••{tail}"


@dataclass
class HumanProof:
    """One verified human, for the duration of one request.

    Deliberately carries NO wallet list. The route hands `cluster` to the tape
    and the tape answers; nothing here holds a fleet, so "only the nullifier is
    retained" is literally true rather than aspirational — and even the nullifier
    is dropped when the request ends.
    """

    nullifier: str
    cluster: str
    window: int
    verified_at: float
    backend: str
    sandbox: bool

    @property
    def masked(self) -> str:
        return mask(self.nullifier)

    def public(self) -> dict:
        """What a response may say about the human. Never the nullifier."""
        return {"cluster": self.cluster, "window": self.window,
                "backend": self.backend, "sandbox": self.sandbox}


class HumanProofRequired(Exception):
    """The 401 challenge: a nonce to sign, and what to sign it for.

    401 rather than 403: the caller is not forbidden, they are unauthenticated,
    and `WWW-Authenticate` is how a client is told what to present.
    """

    status_code = 401

    def __init__(self, body: dict, headers: dict[str, str]) -> None:
        super().__init__("Human Proof Required")
        self.body = body
        self.headers = headers


def _b64(obj: dict) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


class _Nonces:
    """Single-use challenge nonces, TTL-bounded and capacity-bounded.

    A nonce that could be spent twice would make every proof replayable, which
    would turn "this human authorized this call" into "this human authorized one
    call, once, and anyone who saw it can repeat it forever". Bounded by count as
    well as time so a long-lived process cannot be made to leak memory by asking
    for challenges it never answers.
    """

    def __init__(self, ttl_s: float = NONCE_TTL_S, max_keys: int = _MAX_NONCES) -> None:
        self._issued: OrderedDict[str, float] = OrderedDict()
        self._ttl = ttl_s
        self._max = max_keys

    def issue(self, *, now: float | None = None) -> str:
        t = time.monotonic() if now is None else now
        nonce = secrets.token_hex(16)
        self._issued[nonce] = t
        while len(self._issued) > self._max:
            self._issued.popitem(last=False)
        return nonce

    def spend(self, nonce: str, *, now: float | None = None) -> bool:
        """True exactly once per nonce, and only inside its TTL."""
        t = time.monotonic() if now is None else now
        issued = self._issued.pop(nonce, None)
        return issued is not None and (t - issued) < self._ttl


class HumanVerifier(ABC):
    """Base gate: the challenge/verify seam `require_human` calls.

    Subclasses turn a presented credential into a nullifier and nothing else.
    Deriving the cluster id is done here, once, so no backend can accidentally
    ship its own copy of the arithmetic the whole tape depends on.
    """

    backend = "base"

    def __init__(self) -> None:
        self.nonces = _Nonces()
        self.verified = 0

    # --- the seam ---

    @abstractmethod
    def challenge(self, request: Request) -> HumanProofRequired:
        """The 401 to raise when no proof is present."""

    @abstractmethod
    async def nullifier_of(self, request: Request, header: str) -> str:
        """Verify a presented credential; raise 401 if it is not good."""

    # --- shared ---

    def salt_ok(self) -> bool | None:
        """Does the configured salt hash to the deployed contract's commitment?

        None when there is nothing to compare against. False is the failure worth
        catching loudly: a wrong salt derives cluster ids that match nothing on
        the tape, so every human comes back with an empty union that reads
        exactly like "this human has never traded" — a silent zero, which is the
        one answer a benchmark must never give by accident.
        """
        s = get_settings()
        if not s.humanid_salt or not s.humanid_salt_commitment:
            return None
        try:
            return "0x" + salt_commitment(s.humanid_salt).hex() == s.humanid_salt_commitment.lower()
        except ValueError:
            return False

    async def prove(self, request: Request, header: str) -> HumanProof:
        nullifier = await self.nullifier_of(request, header)
        s = get_settings()
        if not s.humanid_salt:
            # Fail closed. Without a salt there is no cluster id, and answering
            # with an un-scoped union would be the leak this gate exists to stop.
            raise HTTPException(status_code=503, detail="human proofs are not configured")
        if self.salt_ok() is False:
            raise HTTPException(
                status_code=503,
                detail="human proofs are misconfigured: the salt does not match the "
                "commitment the mirror was deployed with",
            )
        window = current_window()
        try:
            cluster = "0x" + cluster_id(nullifier, s.humanid_salt, window).hex()
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="malformed proof") from exc
        self.verified += 1
        return HumanProof(
            nullifier=nullifier, cluster=cluster, window=window,
            verified_at=time.time(), backend=self.backend, sandbox=s.humanid_sandbox,
        )

    def _challenge_body(self, request: Request, nonce: str) -> tuple[dict, dict[str, str]]:
        s = get_settings()
        body = {
            "error": "human proof required",
            "scheme": "agentkit",
            "app_id": s.humanid_app_id or None,
            "nonce": nonce,
            "expires_in_seconds": int(NONCE_TTL_S),
            # A proof is scoped to one resource so one minted for another route
            # or another service cannot be presented here.
            "resource": getattr(getattr(request, "url", None), "path", "") or "",
            "sandbox": s.humanid_sandbox,
            "header": PROOF_HEADER,
        }
        headers = {
            "WWW-Authenticate": f'HumanProof nonce="{nonce}"',
            CHALLENGE_HEADER: _b64(body),
        }
        return body, headers


class DevHumanVerifier(HumanVerifier):
    """Dev gate — accepts `humanid <nullifier-hex>:<nonce>`. No network, no World.

    Real in every respect that the security properties depend on: the nonce is
    still single-use and still expires, so replay is genuinely exercised rather
    than assumed. What it does not do is prove a human exists — which is exactly
    why /humanid/info reports the backend, and why the README says what a
    Sandbox identity is and is not.
    """

    backend = "dev"

    def challenge(self, request: Request) -> HumanProofRequired:
        body, headers = self._challenge_body(request, self.nonces.issue())
        body["scheme"] = "dev"
        return HumanProofRequired(body=body, headers=headers)

    async def nullifier_of(self, request: Request, header: str) -> str:
        try:
            scheme, rest = header.split(" ", 1)
            nullifier, nonce = rest.rsplit(":", 1)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="malformed human proof") from exc
        if scheme.lower() != "humanid":
            raise HTTPException(status_code=401, detail="unsupported proof scheme")
        if not self.nonces.spend(nonce.strip()):
            # Covers both a replay and an expiry. Saying which would tell an
            # attacker whether a nonce was ever real.
            raise HTTPException(status_code=401, detail="challenge nonce is not spendable")
        return nullifier.strip()


class AgentKitVerifier(HumanVerifier):
    """World AgentKit proofs, verified against the Developer Portal.

    NOT YET EXERCISED AGAINST LIVE SANDBOX. Access was still pending when this
    was written, so the remote call is isolated in `_verify_remote` and every
    path through it fails closed. The surrounding machinery — nonce lifetime,
    resource scoping, cluster derivation, masking — is shared with the dev gate
    and is tested; what is unproven is the request/response shape of one HTTP
    call, and this docstring is the honest place to say so rather than a README
    implying it has run.
    """

    backend = "agentkit"

    def challenge(self, request: Request) -> HumanProofRequired:
        body, headers = self._challenge_body(request, self.nonces.issue())
        return HumanProofRequired(body=body, headers=headers)

    async def _verify_remote(self, payload: dict, nonce: str) -> str:
        import httpx

        s = get_settings()
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                s.humanid_verifier_url,
                json={"app_id": s.humanid_app_id, "nonce": nonce, "proof": payload},
            )
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail="proof rejected by the verifier")
        data = r.json()
        if not data.get("verified"):
            raise HTTPException(status_code=401, detail="proof rejected by the verifier")
        nullifier = str(data.get("nullifier_hash") or data.get("nullifier") or "")
        if not nullifier:
            raise HTTPException(status_code=401, detail="verifier returned no nullifier")
        return nullifier

    async def nullifier_of(self, request: Request, header: str) -> str:
        s = get_settings()
        if not (s.humanid_verifier_url and s.humanid_app_id):
            raise HTTPException(status_code=503, detail="human proofs are not configured")
        try:
            payload = json.loads(base64.b64decode(header))
        except Exception as exc:
            raise HTTPException(status_code=401, detail="malformed human proof") from exc
        nonce = str(payload.get("nonce") or "")
        if not self.nonces.spend(nonce):
            raise HTTPException(status_code=401, detail="challenge nonce is not spendable")
        # A proof scoped to another app must not authorize anything here.
        if payload.get("app_id") and payload["app_id"] != s.humanid_app_id:
            raise HTTPException(status_code=401, detail="proof is scoped to another app")
        try:
            return await self._verify_remote(payload, nonce)
        except HTTPException:
            raise
        except Exception as exc:
            # Fail closed on every transport error. An unverified human must
            # never be served as a verified one.
            log.warning("agentkit verification failed: %s", type(exc).__name__)
            raise HTTPException(status_code=401, detail="proof could not be verified") from exc


# --- module singleton + selection (mirrors x402.get_facilitator) --------------
_verifier: HumanVerifier | None = None


def get_verifier() -> HumanVerifier:
    global _verifier
    if _verifier is None:
        s = get_settings()
        mode = s.humanid_mode.strip().lower()
        if mode == "dev":
            _verifier = DevHumanVerifier()
        elif mode == "agentkit":
            if not (s.humanid_verifier_url and s.humanid_app_id):
                log.warning("humanid_mode=agentkit but verifier URL/app id unset — fails closed")
            _verifier = AgentKitVerifier()
        else:  # auto — AgentKit only if the URL and app id actually look real
            url, app = s.humanid_verifier_url.strip(), s.humanid_app_id.strip()
            _verifier = AgentKitVerifier() if url.startswith("http") and app else DevHumanVerifier()
    return _verifier


def set_verifier(verifier: HumanVerifier) -> None:
    """Install a verifier (tests inject one wired to a mock transport)."""
    global _verifier
    _verifier = verifier


def reset_verifier() -> None:
    global _verifier
    _verifier = None


async def require_human(
    request: Request,
    human_proof: str | None = Header(default=None, alias=PROOF_HEADER),
) -> HumanProof:
    """FastAPI dependency: 401 unless a valid human proof is present."""
    verifier = get_verifier()
    if human_proof is None:
        raise verifier.challenge(request)
    proof = await verifier.prove(request, human_proof)
    request.state.human = proof
    log.info("human proof verified %s (%s, window %d)", proof.masked, proof.backend, proof.window)
    return proof
