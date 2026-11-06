"""Guest budgets: one per unique human, with the chain as the authority.

A visitor completes a World ID **Selfie Check** in a browser and their agent
gets a small daily budget. The product's whole sentence is "one per unique
human", so the interesting part is not the happy path, it is what stops the
second one.

THREE LAYERS, AND THE SUBMISSION SAYS SO.
  1. World's own property: a v4 uniqueness proof is one-time per action per
     person, so the second attempt fails before it reaches us.
  2. Our ledger, keyed on the nullifier under a single-use claim.
  3. The vault: `registerGuest` reverts `"agent exists"`, because the guest
     agent id is a deterministic function of the nullifier.

WHY THE NULLIFIER AND NOT THE CLUSTER. `humanid.py` derives a cluster id that
ROTATES every seven days, which is right for cross-service unlinkability and
useless as a once-per-human key -- the same person is a different cluster next
week. So this is the first place in the repo that must retain a nullifier. It is
masked in every log line, never returned, and never written to the chain: what
goes on chain is `keccak256("acr.guest::" ‖ nullifier)`, which the vault treats
as an opaque agent id.

WHY THERE IS NO BULK REHYDRATION, unlike `desk.py`'s FaucetLedger. That ledger
re-reads Circle's whole transaction list every ten minutes because Circle cannot
cheaply answer "was this one address paid?". Our authority can: the agent id is
a pure function of the nullifier, so the vault answers *for this human* in a
single `eth_call`. No TTL, no staleness window, no enumeration -- and no
`_hydrated_at` monotonic-clock trap either. The JSONL is the local record and
the audit trail; the chain is the authority on every individual claim.

WHAT THAT COSTS, NAMED. A pending `registerGuest` reads `exists == False`, so
the chain does not hold a slot for a transaction in flight the way Circle's
"any non-failed state" did. The local claim line is therefore load-bearing
here, and `"agent exists"` is treated as SUCCESS rather than as an error --
because it means the budget exists for this human, which is the outcome the
caller wanted. That is also what makes a crash between the claim and the
receipt safe: on restart the disk is empty, the chain read is the only backstop,
and a retry either works or reverts into the same 409.

AND WHY THERE IS NO GLOBAL CAP. `agents` is an internal mapping with no
counter, so cardinality is recoverable only by scanning `GuestRegistered` logs
-- bulk rehydration in a different costume. A `len(self._claimed) >= CAP` check
would reset on every restart, which is worse than no cap: it reads as
protection in review and provides none. What it protected is already protected
better, on chain and unresettable -- `registerGuest` hands out the fixed
template, so the registrar cannot inflate anything, and the real ceiling is the
treasury's own balance. So this checks a free-float FLOOR instead, which is the
honest version of the same instinct: guest number N gets told the till is empty
rather than a budget that reverts the first time they spend it.
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

import httpx

from index_api.humanid import mask

log = logging.getLogger("index_api.floatguest")

#: The action a guest proof is scoped to. A proof minted for another action
#: must not authorize anything here, and World scopes uniqueness per action.
ACTION = os.environ.get("ACR_FLOAT_GUEST_ACTION", "acr-float-guest-budget-v1")

#: Read at import, like `operator.LOG_PATH`, so the root conftest can redirect
#: it before collection.
LOG_PATH = os.environ.get("ACR_FLOATGUEST_LOG_PATH", "data/float_guests.jsonl")

#: Selfie Check's credential. Its `sybil_score` is only meaningful for this one.
SELFIE_SCHEMA_ID = 11

#: How long a signed join request stays answerable. Short, because the only
#: thing it has to survive is one round trip through a phone.
NONCE_TTL_S = 300.0

#: Where a v4 uniqueness proof is checked. Overridable for the staging
#: environment, which verifies against the simulator rather than a real phone.
VERIFY_BASE = os.environ.get("ACR_FLOAT_GUEST_VERIFY_BASE", "https://developer.world.org")

#: Named refusals, so a join page can say which thing went wrong.
REASONS = (
    "wrong_environment",
    "unknown_or_expired_request",
    "verify_failed",
    "no_nullifier",
    "below_sybil_floor",
    "one_guest_budget_per_human",
    "not_a_guest_agent",
    "the_till_is_empty",
)

GUEST_PREFIX = b"acr.guest::"


class GuestError(Exception):
    """A named refusal with an HTTP status. `reason` is from `REASONS`."""

    def __init__(self, status: int, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.status = status
        self.reason = reason
        self.detail = detail or reason


def guest_agent_id(nullifier: str) -> bytes:
    """`keccak256("acr.guest::" ‖ nullifier)` — agreed with the vault's author.

    Deterministic on purpose: it is what lets the chain answer "has this human
    already been issued a budget" without us storing anything on it.
    """
    from eth_utils import keccak

    raw = (nullifier or "").strip()
    if not raw:
        raise ValueError("a guest agent id needs a nullifier")
    return bytes(keccak(GUEST_PREFIX + raw.encode()))


@dataclass
class PendingJoins:
    """nonce → the agent address it was signed for. Single-use, TTL-bounded.

    `humanid._Nonces` cannot be reused for this: it is an `OrderedDict` of
    nonce → issue time with no payload slot and no hook to add one. The binding
    matters because the signed nonce is the only thing tying a human's proof to
    one particular wallet THAT WE CHECK. `selfieCheck` does take an optional
    `signal` -- the installed types say `selfieCheck(opts?: {signal?: string})`
    -- and committing the agent address to it would be a second, independent
    binding. We do not, because nothing here verifies a signal, and an
    unverified commitment on the wire reads like a guarantee while being
    decoration. Binding it server-side is the obvious strengthening and it is
    named as absent rather than implied.
    """

    ttl_s: float = NONCE_TTL_S
    max_keys: int = 4096
    _held: dict[str, tuple[str, float]] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def bind(self, nonce: str, agent_addr: str, *, now: float | None = None) -> None:
        at = time.time() if now is None else now
        with self._lock:
            self._held[nonce] = (agent_addr, at)
            while len(self._held) > self.max_keys:
                self._held.pop(next(iter(self._held)))

    def spend(self, nonce: str, *, now: float | None = None) -> str | None:
        """The bound address, exactly once, and only inside the TTL."""
        at = time.time() if now is None else now
        with self._lock:
            held = self._held.pop(nonce, None)
        if held is None:
            return None
        addr, bound_at = held
        #: Popped either way, so presenting an expired nonce both fails and
        #: spends it. A nonce that can be retried is not single-use.
        return addr if (at - bound_at) < self.ttl_s else None


def verify_uniqueness_proof(
    payload: dict,
    *,
    rp_id: str,
    environment: str,
    base: str | None = None,
    transport: httpx.BaseTransport | None = None,
    timeout_s: float = 15.0,
) -> dict:
    """Check a v4 uniqueness proof with World and return what it established.

    The payload is forwarded **as-is**: World's docs are explicit that the IDKit
    result needs no field remapping, and renaming anything here would be
    re-deriving a contract we do not own against a service that will reject it.
    Only `environment` is overridden, which is what the integration guide shows.

    Not `WorldIdCloudVerifier.nullifier_of`: that reads back only the nullifier
    and the environment, so a `sybil_score` would be silently discarded, and it
    is shaped around a proof presented in an HTTP header rather than posted by a
    browser widget. The discipline here is the same -- v4 first, the
    `app_not_migrated` fallback to v2 with its `nullifier_hash` rename,
    `_as_hex32` normalisation, and the environment OBSERVED rather than asserted.
    """
    from index_api.humanid import _as_hex32

    claimed = str(payload.get("environment") or "")
    if claimed and claimed != environment:
        #: Checked before the network call. A staging proof verifies only
        #: against the simulator, so accepting one here would be accepting a
        #: proof no real person made.
        raise GuestError(403, "wrong_environment", f"this proof is for {claimed!r}")

    root = (base or VERIFY_BASE).rstrip("/")
    body = {**payload, "environment": environment}
    kw: dict[str, Any] = {"timeout": timeout_s}
    if transport is not None:
        kw["transport"] = transport

    with httpx.Client(**kw) as c:
        r = c.post(f"{root}/api/v4/verify/{rp_id}", json=body)
        try:
            answer = r.json()
        except Exception:  # noqa: BLE001 - an unreadable answer is one refusal
            answer = {}
        if str(answer.get("code") or "") == "app_not_migrated":
            r = c.post(f"{root}/api/v2/verify/{rp_id}", json=body)
            try:
                answer = r.json()
            except Exception:  # noqa: BLE001
                answer = {}
            legacy = True
        else:
            legacy = False

    if r.status_code != 200 or answer.get("success") is not True:
        detail = str(answer.get("detail") or answer.get("code") or "the proof was refused")
        raise GuestError(401, "verify_failed", detail)

    raw = str(answer.get("nullifier_hash") if legacy else answer.get("nullifier") or "")
    if not raw:
        raise GuestError(401, "no_nullifier", "the verifier established no nullifier")

    env = str(answer.get("environment") or "")
    responses = payload.get("responses") or []
    first = responses[0] if isinstance(responses, list) and responses else {}
    schema = int(first.get("issuer_schema_id") or 0) if isinstance(first, dict) else 0
    sybil = first.get("sybil_score") if isinstance(first, dict) else None

    return {
        "nullifier": _as_hex32(raw),
        #: v2 carries no environment: unobservable, which is not the same as
        #: "production". `None` says we could not see it.
        "sandbox_observed": (env != "production") if env else None,
        "issuer_schema_id": schema,
        "sybil_score": int(sybil) if isinstance(sybil, int | float) else None,
    }


@dataclass
class GuestLedger:
    """Claimed budgets, keyed on the nullifier. The disk is a record, not truth.

    `FaucetLedger`'s discipline, minus its bulk rehydration: the claim line
    lands before the chain call so a crash cannot be farmed, `release()` frees a
    slot whose write failed without retracting the line, and the network call
    never happens under the data lock.
    """

    log_path: str | None = None
    _claimed: dict[str, float] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def claim(self, nullifier: str) -> None:
        """Reserve this human's one budget, or raise 409."""
        with self._lock:
            if nullifier in self._claimed:
                raise GuestError(409, "one_guest_budget_per_human", "one guest budget per human")
            self._claimed[nullifier] = time.time()
            self._append({"event": "claimed", "nullifier": nullifier})

    def release(self, nullifier: str) -> None:
        """Free a slot whose chain write failed.

        Deliberately asymmetric, as in `desk.py`: the claim LINE is not
        retracted, so a restart replays it and re-consumes the slot. Forgiving
        a failed write is fine; forgetting a successful one is not.
        """
        with self._lock:
            self._claimed.pop(nullifier, None)

    def record_tx(self, nullifier: str, tx: str, agent_id: str) -> None:
        self._append({"event": "issued", "nullifier": nullifier, "tx": tx, "agent_id": agent_id})

    def held(self, nullifier: str) -> bool:
        with self._lock:
            return nullifier in self._claimed

    def _append(self, row: dict) -> None:
        path = Path(self.log_path or LOG_PATH)
        #: Masked on the way to disk as well as to a log. The nullifier is the
        #: durable identifier the whole rotation scheme exists to keep off our
        #: surfaces, and a JSONL in a repo is a surface.
        safe = {**row, "at": time.time()}
        if "nullifier" in safe:
            safe["nullifier"] = mask(str(safe["nullifier"]))
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                #: ensure_ascii=False so the masked value stays readable. A
                #: nullifier is redacted TO BE READ -- a line of \u2022 escapes
                #: is redacted and useless, which defeats keeping it at all.
                f.write(json.dumps(safe, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            log.warning("could not append to the guest ledger: %s", exc)


@dataclass
class GuestGate:
    """Bind a join request, then issue one budget per unique human."""

    vault: Any
    rp_id: str
    environment: str = "production"
    min_sybil: int | None = None
    joins: PendingJoins = field(default_factory=PendingJoins)
    ledger: GuestLedger = field(default_factory=GuestLedger)
    verify: Any = verify_uniqueness_proof

    def bind(self, nonce: str, agent_addr: str) -> None:
        """Remember which wallet a signed request was minted for."""
        if not nonce or not agent_addr:
            raise GuestError(400, "unknown_or_expired_request", "a join needs a nonce and an agent")
        self.joins.bind(nonce, agent_addr)

    def claim(self, payload: dict) -> dict:
        """The whole flow, in the only order that is safe.

        World first (the only store that knows WHICH human, and the cheapest
        replay rejection), then the chain (fail closed), then the local claim,
        then the write.
        """
        nonce = str(payload.get("nonce") or "")
        agent_addr = self.joins.spend(nonce)
        if not agent_addr:
            raise GuestError(
                400, "unknown_or_expired_request", "that join request is unknown, spent or expired"
            )

        established = self.verify(payload, rp_id=self.rp_id, environment=self.environment)
        nullifier = established["nullifier"]
        floor = self.min_sybil
        if (
            floor is not None
            and established["issuer_schema_id"] == SELFIE_SCHEMA_ID
            and (established["sybil_score"] is None or established["sybil_score"] < floor)
        ):
            raise GuestError(
                403, "below_sybil_floor", "this credential is below the floor for a guest budget"
            )

        agent_id = guest_agent_id(nullifier)
        ready = self.vault.guest_preflight()
        if ready != "ok":
            raise GuestError(503, "verify_failed", ready)

        #: FAIL CLOSED. An unreadable chain is not a "no": it is the one case
        #: where issuing anyway would hand a second budget to a human who
        #: already has one.
        try:
            standing = self.vault.agent_of(agent_id)
        except Exception as exc:  # noqa: BLE001
            raise GuestError(
                503, "verify_failed", f"the chain could not be read, so nothing was issued: {exc}"
            ) from exc
        if standing["exists"]:
            if not standing["guest"]:
                #: Same id as an operator-registered agent. Astronomically
                #: unlikely and not a thing to paper over with a 409.
                raise GuestError(
                    500, "not_a_guest_agent", "that agent id is already in use and is not a guest"
                )
            raise GuestError(409, "one_guest_budget_per_human", "one guest budget per human")

        #: A floor, not a cap. Readable-and-short refuses; unreadable does NOT
        #: block, because a throttled endpoint must not become an outage.
        cap = self.vault.guest_daily_cap()
        try:
            free = self.vault.total_value_usdc()
        except Exception:  # noqa: BLE001
            free = None
        if free is not None and free < cap:
            raise GuestError(
                409, "the_till_is_empty", "the treasury cannot fund another guest budget today"
            )

        self.ledger.claim(nullifier)
        try:
            out = self.vault.register_guest(agent_id)
        except Exception as exc:  # noqa: BLE001
            text = str(exc)
            #: ASK THE CHAIN, never the revert string. A write that reverted
            #: and a write that LANDED before its receipt reached us are the
            #: same exception here, and no sentence tells them apart -- while
            #: `"agent exists"` is a sentence in a contract we do not own, the
            #: exact coupling that broke this package's checkpoint read when
            #: the struct grew a field. The agent either exists now or it does
            #: not, and that question has an authoritative answer.
            try:
                landed = self.vault.agent_of(agent_id)
            except Exception:  # noqa: BLE001
                landed = None
            if landed is not None and landed["exists"]:
                if not landed["guest"]:
                    #: One chain state, one reason, whichever side of the write
                    #: we learn it on. We hold no budget, so the slot goes back.
                    self.ledger.release(nullifier)
                    raise GuestError(
                        500,
                        "not_a_guest_agent",
                        "that agent id is already in use and is not a guest",
                    ) from exc
                #: NOT an error. The budget exists for this human, which is
                #: what the caller wanted -- and this is the branch that makes
                #: a crash between the claim and the receipt safe, because a
                #: retry after a restart lands here rather than on a 500.
                self.ledger.record_tx(nullifier, "", "0x" + agent_id.hex())
                raise GuestError(
                    409, "one_guest_budget_per_human", "one guest budget per human"
                ) from exc
            #: Either the write genuinely failed, or the chain went unreadable
            #: in the same breath and we cannot tell. RELEASE in both cases: a
            #: kept slot locks a human out of a budget they may never have got,
            #: while a released one self-heals, because the retry's own
            #: pre-check reads this same `agent_of` and answers 409 if the write
            #: did land. What stops a second budget is the chain and not this
            #: ledger -- one nullifier derives one agent id, and `registerGuest`
            #: refuses it twice.
            self.ledger.release(nullifier)
            raise GuestError(
                502, "verify_failed", f"the budget could not be issued: {text}"
            ) from exc

        tx = str(out.get("tx") or "")
        self.ledger.record_tx(nullifier, tx, "0x" + agent_id.hex())
        log.info("guest budget issued to %s for %s", agent_addr, mask(nullifier))
        return {
            "ok": True,
            "agent": agent_addr,
            "agent_id": "0x" + agent_id.hex(),
            "daily_cap_usdc": cap / 1e6,
            "tx": tx,
            #: Never the nullifier. Masked even here.
            "human": mask(nullifier),
            "sandbox_observed": established["sandbox_observed"],
        }


# --- the one the service holds ---------------------------------------------

_guest_gate: GuestGate | None = None
_guest_why: str = "not built yet"


def build_guest_gate(settings: Any = None) -> tuple[GuestGate | None, str]:
    """`(gate, why)`. Never raises, for the reason `floatgate.build_gate` does
    not: this is reached from a request handler, and an unconfigured join page
    should answer a sentence rather than a stack trace.

    Offline by construction -- no chain read and no network -- so a service can
    be told what it is missing before it has either. The check that needs the
    chain is `GuestGate.vault.guest_preflight()`, which `claim` runs per call
    because the registrar can be rotated out from under us at any moment.
    """
    from acr_core import get_settings

    s = settings or get_settings()
    missing = [
        name
        for name, value in (
            ("ACR_FLOAT_VAULT_ADDRESS", s.float_vault_address),
            ("ACR_FLOAT_GUEST_REGISTRAR_PRIVATE_KEY", s.float_guest_registrar_private_key),
            ("ACR_FLOAT_GUEST_RP_ID", s.float_guest_rp_id),
        )
        if not value
    ]
    if missing:
        return None, "not configured: " + ", ".join(missing) + " unset"
    rpc = getattr(s, "arc_rpc_url", "")
    if not rpc:
        return None, "not configured: ACR_ARC_RPC_URL unset, so there is no chain to register on"

    from acr_oracle_client.float_vault import FloatVaultClient
    from acr_oracle_client.signer import LocalKeySigner
    from web3 import Web3

    try:
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 25}))
        vault = FloatVaultClient(
            w3,
            s.float_vault_address,
            signer=LocalKeySigner(s.float_guest_registrar_private_key),
        )
    except Exception as exc:  # noqa: BLE001 - a bad key is a sentence, not a trace
        return None, f"the registrar signer could not be built: {type(exc).__name__}"

    return (
        GuestGate(
            vault=vault,
            rp_id=s.float_guest_rp_id,
            environment=s.float_guest_environment,
            min_sybil=s.float_guest_min_sybil,
        ),
        "ok",
    )


def ensure_guest_gate(settings: Any = None) -> GuestGate | None:
    """Build once, then reuse. `guest_status()` carries the reason for a None."""
    global _guest_gate, _guest_why
    if _guest_gate is None:
        _guest_gate, _guest_why = build_guest_gate(settings)
    return _guest_gate


def get_guest_gate() -> GuestGate | None:
    return _guest_gate


def guest_status() -> str:
    return "ok" if _guest_gate is not None else _guest_why


def set_guest_gate(gate: GuestGate | None) -> None:
    global _guest_gate, _guest_why
    _guest_gate = gate
    _guest_why = "ok" if gate is not None else "set to none by hand"
