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
    "expires_in_s",
    "tx",
)


@dataclass
class GateCheckpoint:
    """One parked payment. Carries no secret, by construction."""

    id: int
    kind: str
    req: SpendReq
    reason: str
    #: 6-decimal USDC units, which is what the chain speaks. `public()` divides,
    #: because every `_usdc` field in this repo carries decimal USDC and a view
    #: that served 18540000 under that name would be out by a million.
    quote_units: int
    fair_units: int
    req_hash: bytes
    #: HOST clock: the freshness window and our own patience.
    opened_at: float
    #: CHAIN clock: what the vault will compare against. Never used to decide
    #: expiry here -- only shown, so a human sees the countdown the chain means.
    expires_at_chain: int
    user_code: str
    verify_uri: str
    interval: int
    #: The TTL the vault was given, so the countdown is a duration rather than
    #: a difference between two clocks.
    ttl_s: int = 300
    #: When this checkpoint was last polled, on the HOST clock. Zero means
    #: never, so the first poll is due immediately.
    last_poll_at: float = 0.0
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
            "quote_usdc": self.quote_units / 1e6,
            "fair_usdc": self.fair_units / 1e6,
            "user_code": self.user_code if self.status == OPEN else "",
            "verify_uri": self.verify_uri if self.status == OPEN else "",
            "expires_at": self.expires_at_chain,
            #: The countdown, and the ONLY number a clock should be read from.
            #: `expires_at` is the vault's `block.timestamp`; a browser
            #: subtracting its own wall clock from it would be wrong by however
            #: far the two epochs sit apart, which on a local chain has been
            #: measured at 3,815 seconds. A DURATION is the same length in both
            #: clocks, so elapsed host seconds against the chain's own TTL is
            #: sound where a difference of epochs is not.
            "expires_in_s": max(0, round(self.ttl_s - (time.time() - self.opened_at))),
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
        ours = getattr(self.approver, "address", None)
        if ours is not None:
            theirs = self.vault.human_approver()
            if ours.lower() != theirs.lower():
                #: `vault_status` already refuses an approver of ZERO, and an
                #: executor that is not authorized. It cannot check this one,
                #: because it does not hold the approver key -- this gate does.
                #: Unchecked, the first sign is `executeApproved` reverting
                #: "bad approval" AFTER a human has answered on their phone,
                #: which reads as the chain rejecting a verified person.
                #: `setApprover` is onlyOwner and NOT one-shot, so the fix is
                #: one transaction from the owner key.
                return (
                    "our approver key is not the one the vault accepts "
                    f"(vault {theirs[:10]}…, ours {ours[:10]}…)"
                )
        if self.treasurer is None:
            #: Correct exactly once -- during enrollment, which exists to learn
            #: the pair. After that, an unenrolled gate would let any verified
            #: human clear a payment.
            return "no treasurer is enrolled, so any verified human could approve"
        want = treasurer_binding(*self.treasurer)
        have = "0x" + self.vault.treasurer_binding().hex()
        unadvertised = self.unadvertised_assurance()
        if unadvertised:
            #: An essential `claims` entry naming a class the issuer does not
            #: advertise is not a preference it can ignore -- it is a
            #: requirement it cannot meet, and the refusal arrives as
            #: `access_denied`, which is also what a human declining looks
            #: like. Catch it here, where the reason can say which.
            return (
                "this issuer does not advertise "
                + ", ".join(sorted(unadvertised))
                + " -- asking for it as an essential claim would be refused as if the human declined"
            )
        if want.lower() != have.lower():
            #: The vault would happily accept our signature over the binding IT
            #: stores, even though that binding names somebody else. The
            #: approval would be valid and bind to the wrong person.
            return (
                "the vault's treasurer binding is not the enrolled treasurer's "
                f"(vault {have[:10]}…, enrolled {want[:10]}…)"
            )
        return "ok"

    def unadvertised_assurance(self) -> set[str]:
        """Configured assurance classes this issuer does not list in discovery.

        Empty when discovery cannot be read: an unreachable provider is a
        different problem and the poll table already refuses to call it an
        approval.
        """
        try:
            supported = set(self.flow.supported_acr())
        except Exception:  # noqa: BLE001 - unreadable discovery is not a config error
            return set()
        if not supported:
            return set()
        asked: set[str] = set()
        for kind in ("spend", "policy"):
            asked |= set(self.validator_for(kind).accepted_acr)
        return asked - supported

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
            quote_units=req.quote_total,
            fair_units=int(verdict.get("fair_usdc") or 0),
            req_hash=req_hash,
            opened_at=time.time(),
            expires_at_chain=parked["expires_at"],
            user_code=started.user_code,
            verify_uri=started.public()["verification_uri"],
            interval=started.interval,
            ttl_s=self.ttl_s,
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
                "quote_units": cp.quote_units,
                "fair_units": cp.fair_units,
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
        #: Stamped BEFORE the call, like every chore in `keeper.py`: a poll that
        #: throws must still wait out its interval rather than spin.
        cp.last_poll_at = time.time()
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

    def due(self, now: float | None = None) -> list[int]:
        """Open checkpoints whose own poll interval has elapsed.

        The provider sets the interval and `slow_down` widens it, so polling on
        the worker's cadence instead of each checkpoint's would earn exactly the
        rate limit that widening exists to avoid. Oldest first, so a backlog
        drains in the order it was parked.
        """
        at = time.time() if now is None else now
        return [
            cp.id
            for cp in sorted(self._cps.values(), key=lambda c: c.id)
            if cp.status == OPEN and at - cp.last_poll_at >= cp.interval
        ]

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


# --- configuration ---------------------------------------------------------

#: The two classes BOTH issuers advertise, and the only two. Probed on
#: `auth.world.org` and `sandbox.auth.world.org`: `acr_values_supported` is
#: exactly these. A `selfie` class in a default would be a requirement no
#: issuer can meet, refused as `access_denied` -- indistinguishable from a human
#: declining. The step-up guide documents `selfie`; discovery does not offer it.
ORB = "https://world.org/oidc/acr/orb"
ORB_FACE = "https://world.org/oidc/acr/orb-face"

#: A policy change must not be clearable by a passkey. World documents that only
#: the passkey factor asserts MFA and that it "does not assert a fresh World
#: proof", so a policy checkpoint requires a live face and forbids `mfa`. A knob
#: rather than a constant because an operator without an Orb may be unable to
#: achieve a face factor at all, and then the honest answer is a second
#: independent verification rather than a stronger one.
POLICY_REQUIRE_FACE = os.environ.get("ACR_FLOAT_POLICY_REQUIRE_FACE", "1").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

#: How often the worker looks. The device grant's own interval is what actually
#: paces each checkpoint; this only has to be no slower than that.
TICK_S = float(os.environ.get("ACR_FLOAT_GATE_TICK_S", "5"))

#: Where the Arc session records what it deployed. Reading the address from
#: there removes a hand-copy nobody can verify; the env var overrides it for a
#: vault that session did not deploy.
DEPLOYMENTS = Path(__file__).resolve().parents[3] / "float" / "deployments"


def gate_enabled() -> bool:
    """The gate runs only where a service asked for it.

    Exactly `keeper.humans_enabled()`'s shape and for the same reason: the
    approver key belongs on one host, and a deployed press that merely has the
    code must not start polling for approvals it cannot sign.
    """
    return os.environ.get("ACR_FLOAT_GATE", "0").strip().lower() in ("1", "true", "yes", "on")


def _classes(raw: str, default: tuple[str, ...]) -> tuple[str, ...]:
    picked = tuple(c.strip() for c in (raw or "").split(",") if c.strip())
    return picked or default


def deployed_vault(chain_id: int, *, root: Path | None = None) -> str:
    """The vault address recorded for this chain, or "" if none is.

    Matched on the record's own `chainId` rather than on the file name, so a
    net nobody agreed to call `arc-testnet` still resolves.
    """
    folder = root or DEPLOYMENTS
    try:
        files = sorted(folder.glob("*.json"))
    except OSError:
        return ""
    for f in files:
        try:
            rec = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if int(rec.get("chainId") or 0) == int(chain_id) and rec.get("vault"):
            return str(rec["vault"])
    return ""


def build_gate(settings: Any = None) -> tuple[HumanGate | None, str]:
    """`(gate, why)`. Never raises: an unconfigured gate is a sentence, not a
    stack trace, because this runs inside a lifespan task where the only thing
    a crash achieves is a press that will not boot.

    Offline by construction -- no discovery fetch, no chain read -- so a service
    can be told what it is missing before it has a network. The checks that need
    the network live in `HumanGate.preflight()`.
    """
    from acr_core import get_settings

    s = settings or get_settings()

    if not gate_enabled():
        return None, "the World gate is not switched on for this service (ACR_FLOAT_GATE)"
    missing = [
        name
        for name, value in (
            ("ACR_WORLD_OIDC_ISSUER", s.world_oidc_issuer),
            ("ACR_WORLD_OIDC_CLIENT_ID", s.world_oidc_client_id),
            ("ACR_WORLD_OIDC_CLIENT_SECRET", s.world_oidc_client_secret),
            ("ACR_FLOAT_EXECUTOR_PRIVATE_KEY", s.float_executor_private_key),
            ("ACR_FLOAT_APPROVER_PRIVATE_KEY", s.float_approver_private_key),
        )
        if not value
    ]
    if missing:
        return None, "not configured: " + ", ".join(missing) + " unset"

    from acr_oracle_client.float_vault import FloatVaultClient
    from acr_oracle_client.signer import LocalKeySigner
    from web3 import Web3

    from index_api.worldauth import IdTokenValidator
    from index_api.worldflow import DeviceFlow

    rpc = s.arc_rpc_url
    if not rpc:
        return None, "not configured: ACR_ARC_RPC_URL unset, so there is no chain to release on"
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 25}))
    try:
        chain_id = int(w3.eth.chain_id)
    except Exception as exc:  # noqa: BLE001 - an unreachable RPC is a sentence
        return None, f"the Arc endpoint did not answer: {_short(exc)}"

    vault_addr = s.float_vault_address or deployed_vault(chain_id)
    if not vault_addr:
        return None, (
            f"no FloatVault for chain {chain_id}: set ACR_FLOAT_VAULT_ADDRESS, or deploy one so "
            "float/deployments records it"
        )

    try:
        executor = LocalKeySigner(s.float_executor_private_key)
        approver = LocalKeySigner(s.float_approver_private_key)
    except Exception as exc:  # noqa: BLE001
        return None, f"a gate key would not load: {_short(exc)}"
    if executor.address.lower() == approver.address.lower():
        #: The vault refuses `approver is an executor`, but refusing here names
        #: the problem before a checkpoint is ever parked against it.
        return (
            None,
            "the executor and the approver are the same key, so one key could approve itself",
        )

    flow = DeviceFlow(
        issuer=s.world_oidc_issuer,
        client_id=s.world_oidc_client_id,
        client_secret=s.world_oidc_client_secret,
        auth_method=s.world_oidc_auth_method or "basic",
    )
    vault = FloatVaultClient(w3, vault_addr, signer=executor)

    treasurer = (
        (s.world_treasurer_iss, s.world_treasurer_sub)
        if (s.world_treasurer_iss and s.world_treasurer_sub)
        else None
    )
    spend = IdTokenValidator(
        issuer=s.world_oidc_issuer,
        audience=s.world_oidc_client_id,
        accepted_acr=_classes(s.world_acr_values, (ORB,)),
        jwks=flow.jwks,
        treasurer=treasurer,
        skew_s=s.world_auth_time_skew_s,
    )
    policy = IdTokenValidator(
        issuer=s.world_oidc_issuer,
        audience=s.world_oidc_client_id,
        accepted_acr=_classes(s.world_policy_acr_values, (ORB_FACE, ORB)),
        jwks=flow.jwks,
        require_amr=("face",) if POLICY_REQUIRE_FACE else (),
        forbid_amr=("mfa",),
        treasurer=treasurer,
        skew_s=s.world_auth_time_skew_s,
    )

    gate = HumanGate(
        flow=flow,
        vault=vault,
        validator_for=lambda kind: policy if kind == "policy" else spend,
        approver=approver,
        ttl_s=int(s.float_checkpoint_ttl_s),
        treasurer=treasurer,
    )
    return gate, "ok"


# --- the module singleton, mirroring humanid.get_verifier() ----------------

_gate: HumanGate | None = None
_gate_why: str = "not built yet"
_tick_lock = threading.Lock()


def get_gate() -> HumanGate | None:
    """Whatever is currently set. Does not build -- see `ensure_gate`."""
    return _gate


def ensure_gate(settings: Any = None) -> HumanGate | None:
    """Build once, then reuse. `gate_status()` carries the reason for a None."""
    global _gate, _gate_why
    if _gate is None:
        _gate, _gate_why = build_gate(settings)
    return _gate


def gate_status() -> str:
    return "ok" if _gate is not None else _gate_why


def set_gate(gate: HumanGate | None) -> None:
    global _gate, _gate_why
    _gate = gate
    _gate_why = "ok" if gate is not None else "set to none by hand"


def reset_gate() -> None:
    global _gate, _gate_why
    _gate = None
    _gate_why = "not built yet"


def float_once(*, force: bool = False) -> str | None:
    """One look by the gate chore. A verdict string, or None for a quiet look.

    `force` is accepted for symmetry with the other chores; this one has no
    cooldown of its own because each checkpoint carries its own interval.
    """
    if not gate_enabled():
        return None
    gate = ensure_gate()
    if gate is None:
        return f"not polling: {gate_status()}"
    #: Non-blocking, like `keeper._humans_lock`: two overlapping ticks would
    #: race for one single-use device code.
    if not _tick_lock.acquire(blocking=False):
        return None
    try:
        ids = gate.due()
        if not ids:
            return None
        outcomes = []
        for cp_id in ids:
            try:
                outcomes.append(f"{cp_id}:{gate.poll_once(cp_id)['status']}")
            except Exception as exc:  # noqa: BLE001 - one bad checkpoint is not the chore
                log.warning("checkpoint %s could not be polled: %s", cp_id, _short(exc))
                outcomes.append(f"{cp_id}:unpolled")
        return "polled " + ", ".join(outcomes)
    finally:
        _tick_lock.release()
