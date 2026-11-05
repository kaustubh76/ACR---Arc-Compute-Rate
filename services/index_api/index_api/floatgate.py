"""The human checkpoint: park a payment, ask a person, release it once.

This is the join between three pieces that are each provable alone --
`worldflow` (the device grant), `worldauth` (the validation ladder) and
`acr_oracle_client.float_vault` (the chain) -- and the join is where the
interesting failures live.

THREE CLOCKS, KEPT APART. A checkpoint is bounded by three different notions of
time and conflating any two of them produces a bug that only appears under
drift:

  * CHAIN time bounds the vault's TTL. `_consumeApproval` compares against
    `block.timestamp`, so only the chain may decide whether a checkpoint has
    expired. We never predict that; we let `executeApproved` revert and handle
    `checkpoint expired` as an outcome. A local anvil has been measured 3,815
    seconds off the host clock, so a host-side guess here would be fiction.
  * HOST time bounds OUR patience, and nothing else. It decides when to stop
    polling, which is a decision about this process, not about the chain.
  * The PROVIDER's clock stamps `auth_time`, and the freshness rung compares it
    against when we opened the checkpoint. Both are wall clocks, so they are
    comparable within a skew; neither is chain time.

THE DEVICE CODE IS NEVER ON A CHECKPOINT. It lives in a separate map private to
the gate, so no serialisation of a `GateCheckpoint` can leak one -- a structural
guarantee rather than a rule somebody has to remember. Same for the id token:
it is validated and discarded, and only the claims survive.

AN UNSUCCESSFUL ESCALATION IS EVIDENCE. Every terminal outcome is written to the
chain with its reason, and appended here, including the refusals. `PolicyWallet`
emits nothing when it refuses -- deliberately, because its refusal ledger is off
chain -- and that is exactly the gap a public `CheckpointResolved` fills.

WHAT WE CANNOT TELL, AND SAY SO. World returns `access_denied` for a human
refusing, for an assurance class that could not be met, and for an identity that
was not the enrolled one. One code, three meanings, and the provider cannot
distinguish them. We record DENIED -- nothing moved, and a refusal is the
closest honest label for "no token was issued for this attempt" -- but the
reason string names all three, because a dashboard that says "the human denied
it" when the truth might be "that account is not verified enough" sends an
operator to debug the wrong thing. It is also our clearest piece of debrief
feedback.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from acr_oracle_client.float_vault import KIND_POLICY, KIND_SPEND, SpendReq

from index_api.worldauth import treasurer_binding
from index_api.worldflow import widen

log = logging.getLogger("index_api.floatgate")

#: Read at import, like `operator.LOG_PATH`, so the root conftest can redirect
#: it before collection. A checkpoint outcome is evidence, so the write is not
#: allowed to fail silently the way a decision row is.
LOG_PATH = os.environ.get("ACR_FLOATGATE_LOG_PATH", "data/float_checkpoints.jsonl")

#: The statuses a caller may see. "open" is the only non-terminal one.
OPEN = "open"
CONSUMED = "consumed"
DENIED = "denied"
EXPIRED = "expired"
FAILED = "failed"
TERMINAL = (CONSUMED, DENIED, EXPIRED, FAILED)
#: Held for the moment between a validated proof and the chain's answer. Not
#: terminal and not open, so neither a second poll nor `waiting()` touches it.
CLAIMED = "claimed"

#: Device-flow stop reasons mapped to the outcome the chain records. Everything
#: not named here is a FAILED with its reason attached: an answer we cannot
#: read is not a denial and must not be filed as one.
_OUTCOME_OF = {
    "refused_or_assurance_unmet": DENIED,
    "device_code_expired": EXPIRED,
}

#: Every field a browser, an agent or a log may see. Anything else is either
#: a secret or an internal clock, and the set is asserted in the tests so a
#: later field cannot drift into the public view unnoticed.
PUBLIC_FIELDS = (
    "id",
    "kind",
    "status",
    "reason",
    "agent",
    "seller",
    "index",
    "units",
    "quote_usdc",
    "fair_usdc",
    "user_code",
    "verify_uri",
    "expires_at",
    "tx",
)


@dataclass
class GateCheckpoint:
    """One parked payment. Carries no secret, by construction."""

    id: int
    kind: str
    req: SpendReq
    reason: str
    quote_usdc: int
    fair_usdc: int
    req_hash: bytes
    #: HOST clock: the freshness window and our own patience.
    opened_at: float
    #: CHAIN clock: what the vault will compare against. Never used to decide
    #: expiry here -- only shown, so a human sees the countdown the chain means.
    expires_at_chain: int
    user_code: str
    verify_uri: str
    interval: int
    status: str = OPEN
    outcome_reason: str = ""
    tx: str | None = None
    identity: dict[str, Any] | None = None
    polls: int = 0

    def public(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "reason": self.outcome_reason or self.reason,
            "agent": self.req.agent_id.rstrip(b"\x00").decode(errors="replace"),
            "seller": self.req.seller,
            "index": self.req.index.rstrip(b"\x00").decode(errors="replace"),
            "units": self.req.units,
            "quote_usdc": self.quote_usdc,
            "fair_usdc": self.fair_usdc,
            "user_code": self.user_code if self.status == OPEN else "",
            "verify_uri": self.verify_uri if self.status == OPEN else "",
            "expires_at": self.expires_at_chain,
            "tx": self.tx,
        }


@dataclass
class HumanGate:
    """Opens checkpoints, waits for a person, and releases or records."""

    flow: Any
    vault: Any
    validator_for: Any
    approver: Any
    ttl_s: int = 300
    treasurer: tuple[str, str] | None = None
    log_path: str | None = None
    _cps: dict[int, GateCheckpoint] = field(default_factory=dict, repr=False)
    #: The one place a device code exists. Never on a checkpoint.
    _codes: dict[int, str] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # --- preflight ----------------------------------------------------------

    def preflight(self) -> str:
        """A named refusal or "ok". Checked before anything is parked."""
        status = self.vault.vault_status()
        if status != "ok":
            return status
        if self.treasurer is None:
            #: Correct exactly once -- during enrollment, which exists to learn
            #: the pair. After that, an unenrolled gate would let any verified
            #: human clear a payment.
            return "no treasurer is enrolled, so any verified human could approve"
        want = treasurer_binding(*self.treasurer)
        have = "0x" + self.vault.treasurer_binding().hex()
        if want.lower() != have.lower():
            #: The vault would happily accept our signature over the binding IT
            #: stores, even though that binding names somebody else. The
            #: approval would be valid and bind to the wrong person.
            return (
                "the vault's treasurer binding is not the enrolled treasurer's "
                f"(vault {have[:10]}…, enrolled {want[:10]}…)"
            )
        return "ok"

    # --- opening ------------------------------------------------------------

    def open(
        self, req: SpendReq, *, kind: str = "spend", reason: str = "", acr: tuple[str, ...] = ()
    ) -> dict:
        """Park `req` on chain and start a device flow for it."""
        if kind not in ("spend", "policy"):
            raise ValueError(f"kind must be 'spend' or 'policy', not {kind!r}")
        ready = self.preflight()
        if ready != "ok":
            raise RuntimeError(f"the human gate is not ready: {ready}")

        #: The chain's own verdict, not ours: `classify` is the same ladder the
        #: spend path runs, so the card shows the vault's fair price and the
        #: vault's sentence rather than a second opinion.
        verdict = self.vault.classify(req)
        req_hash = self.vault.req_hash(req)

        parked = self.vault.open_checkpoint(
            agent_id=req.agent_id,
            req_hash=req_hash,
            ttl_s=self.ttl_s,
            kind=KIND_SPEND if kind == "spend" else KIND_POLICY,
        )
        started = self.flow.start(acr or self._acr_for(kind))

        cp = GateCheckpoint(
            id=parked["id"],
            kind=kind,
            req=req,
            reason=reason or verdict.get("reason") or "",
            quote_usdc=req.quote_total,
            fair_usdc=int(verdict.get("fair_usdc") or 0),
            req_hash=req_hash,
            opened_at=time.time(),
            expires_at_chain=parked["expires_at"],
            user_code=started.user_code,
            verify_uri=started.public()["verification_uri"],
            interval=started.interval,
        )
        with self._lock:
            self._cps[cp.id] = cp
            self._codes[cp.id] = started.device_code
        self._append(
            {
                "event": "opened",
                "id": cp.id,
                "kind": kind,
                "reason": cp.reason,
                "quote_usdc": cp.quote_usdc,
                "fair_usdc": cp.fair_usdc,
                "req_hash": req_hash.hex(),
                "tx": parked.get("tx"),
            }
        )
        return cp.public()

    def _acr_for(self, kind: str) -> tuple[str, ...]:
        return tuple(self.validator_for(kind).accepted_acr)

    # --- polling ------------------------------------------------------------

    def poll_once(self, cp_id: int) -> dict:
        """One tick for one checkpoint. Safe to call after it is finished."""
        cp = self._cps.get(cp_id)
        if cp is None:
            raise KeyError(f"no checkpoint {cp_id} in this process")
        #: Not `in TERMINAL`: a checkpoint being executed right now is
        #: "claimed", which is neither open nor finished, and a second poll
        #: that walked past this would re-poll a single-use device code while
        #: the first was still signing.
        if cp.status != OPEN:
            return cp.public()

        #: Our own patience, on the HOST clock. The chain decides the real TTL.
        if time.time() - cp.opened_at > self.ttl_s:
            return self._finish(cp, EXPIRED, "the checkpoint's time to live elapsed")

        cp.polls += 1
        polled = self.flow.poll_once(self._codes.get(cp.id, ""))
        if polled.kind == "pending":
            return cp.public()
        if polled.kind == "slow_down":
            cp.interval = widen(cp.interval, polled)
            return cp.public()
        if polled.kind != "token":
            return self._finish(cp, _OUTCOME_OF.get(polled.reason, FAILED), polled.sentence)

        verdict = self.validator_for(cp.kind).check(polled.id_token, opened_at=cp.opened_at)
        if not verdict.ok:
            #: A token that does not validate is a FAILED verification, never a
            #: denial: nobody refused anything, the proof simply was not good
            #: enough. Nothing is signed on this path.
            return self._finish(cp, FAILED, f"the verification failed: {verdict.reason}")

        #: Single-use, before anything is signed. Two concurrent polls must
        #: produce one execution, and the loser must not sign at all.
        with self._lock:
            if cp.status != OPEN:
                return cp.public()
            cp.status = CLAIMED
        claims = verdict.claims
        cp.identity = {
            "iss": claims.iss,
            "sub": claims.sub,
            "acr": claims.acr,
            "amr": list(claims.amr),
            "auth_time": claims.auth_time,
        }

        try:
            v, r, s = self.vault.sign_approval(
                cp_id=cp.id,
                req_hash=cp.req_hash,
                expires_at=cp.expires_at_chain,
                signer=self.approver,
            )
            out = self.vault.execute_approved(cp_id=cp.id, req=cp.req, v=v, r=r, s=s)
        except Exception as exc:  # noqa: BLE001 - every failure is one outcome
            #: A VALID human and a refused payment is a real state, not a bug:
            #: the vault re-checks the band, the cap and the print on the way
            #: through and reverts if any of them moved since we parked. The
            #: whole transaction rolls back, so the checkpoint is still open on
            #: chain -- but the human's proof is spent, and a device code is
            #: redeemable once, so there is nothing to retry with. Record it.
            return self._finish(cp, FAILED, f"approved, then the vault refused it: {_short(exc)}")

        cp.status = CONSUMED
        cp.outcome_reason = "approved"
        cp.tx = out.get("tx")
        #: `executeApproved` emits CheckpointResolved(CONSUMED, "approved")
        #: itself, so resolving again here would revert "checkpoint closed".
        self._forget_code(cp.id)
        self._append(
            {
                "event": CONSUMED,
                "id": cp.id,
                "tx": cp.tx,
                "identity": cp.identity,
                "polls": cp.polls,
            }
        )
        return cp.public()

    def _finish(self, cp: GateCheckpoint, status: str, reason: str) -> dict:
        cp.status = status
        cp.outcome_reason = reason
        self._forget_code(cp.id)
        tx = None
        try:
            tx = self.vault.resolve_checkpoint(cp_id=cp.id, outcome=status, reason=reason).get("tx")
        except Exception as exc:  # noqa: BLE001
            #: The chain is the record. If we cannot write it, say so loudly in
            #: the ledger rather than reporting a clean refusal we did not make.
            log.warning("could not resolve checkpoint %s on chain: %s", cp.id, _short(exc))
            cp.outcome_reason = f"{reason} (not recorded on chain: {_short(exc)})"
        cp.tx = tx or cp.tx
        self._append(
            {
                "event": status,
                "id": cp.id,
                "reason": cp.outcome_reason,
                "tx": cp.tx,
                "polls": cp.polls,
            }
        )
        return cp.public()

    def _forget_code(self, cp_id: int) -> None:
        with self._lock:
            self._codes.pop(cp_id, None)

    # --- views --------------------------------------------------------------

    def public(self, cp_id: int) -> dict:
        cp = self._cps.get(cp_id)
        if cp is None:
            raise KeyError(f"no checkpoint {cp_id} in this process")
        return cp.public()

    def public_all(self) -> list[dict]:
        #: Newest first: an approvals panel wants the live one at the top.
        return [cp.public() for cp in sorted(self._cps.values(), key=lambda c: -c.id)]

    def waiting(self) -> list[int]:
        return [cp.id for cp in self._cps.values() if cp.status == OPEN]

    # --- the ledger ---------------------------------------------------------

    def _append(self, row: dict) -> None:
        path = Path(self.log_path or LOG_PATH)
        row = {"at": time.time(), **row}
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as f:
                f.write(json.dumps(row, default=str) + "\n")
        except Exception as exc:  # noqa: BLE001
            log.warning("could not append to the checkpoint ledger: %s", _short(exc))


def _short(exc: Exception, limit: int = 160) -> str:
    """One line of a revert reason, never a stack trace."""
    text = str(exc).replace("\n", " ").strip()
    for marker in ("execution reverted: ", "revert "):
        if marker in text:
            text = text.split(marker, 1)[1]
    return text[:limit]


# --- the module singleton, mirroring humanid.get_verifier() ----------------

_gate: HumanGate | None = None


def get_gate() -> HumanGate | None:
    return _gate


def set_gate(gate: HumanGate | None) -> None:
    global _gate
    _gate = gate


def reset_gate() -> None:
    global _gate
    _gate = None
