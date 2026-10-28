"""Reconcile what the agent SAID against what Arc RECORDS that it paid.

``log_decision`` already says it in its own docstring — *"the authoritative
record is on chain"* — and until now nothing read that record. This is the read.

Two sides, joined on one key:

* the **tape** (``operator_decisions.jsonl``) holds the reasoning, and lives on a
  container disk no Render plan in ``render.yaml`` persists;
* the **chain** holds ``Spent(..., decisionHash, ...)`` for every payment, with a
  zero hash rejected and ``consumedDecisionHashes`` blocking replay.

``decision_hash(hashable_record(row))`` recomputes the commitment from a stored
row, so the join needs no shared database and no trust in us. Three findings
matter, and two of them are alarms nobody else can raise:

``unexplained``
    A ``Spent`` on chain with no row behind it. **Money moved and no reasoning
    was recorded.** This is the headline: it is what a compromised agent, a
    bypassed operator, or a lost tape all look like from outside.

``paid_against_decision``
    A row that said *refuse*, *hold* or *reroute*, whose hash is nonetheless on
    chain. The decision and the payment disagree, and the payment won.

``recorded_unseen``
    A row claiming a transaction the chain does not show. Usually a wrong
    chain or a dropped tx; occasionally a record that was never true.

WHAT THIS REFUSES TO JUDGE. A decision row carries no chain id and no wallet
address — verified against the 19 archived rows, which are 27-key rows written
on 2026-10-03 against a ``PolicyWallet`` that is no longer the one in use, and
whose transactions are absent from both live Arc chains. Such a row cannot be
told apart from a payment that genuinely never happened, so it is reported as
``unscoped`` and excluded from every alarm count. Scoring them would manufacture
six alarms out of a schema gap. ``scope_rows`` is how a caller narrows to rows a
given wallet could actually have paid.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from acr_oracle_client.policy import decision_hash

from .operator import PAY, hashable_record

#: Intents that assert money should move. Everything else asserts it should not.
_PAYING = (PAY,)


def row_hash(row: dict) -> str:
    """The on-chain commitment a stored decision row re-derives to.

    Goes through ``hashable_record`` so the same fields are stripped that
    ``as_record`` stripped when the hash was made. A row written by an older,
    narrower version of the dataclass simply has fewer keys and still re-derives
    its own original hash — which is why adding a field to
    ``ObligationDecision`` does not invalidate history, provided no stored row is
    ever rewritten.
    """
    return "0x" + decision_hash(hashable_record(row)).hex()


def scope_rows(rows: list[dict], chain_id: int | None, wallet: str | None) -> tuple[list, list]:
    """Split rows into (in scope, unscoped) for one chain and wallet.

    A row is in scope only if it names the chain and wallet being reconciled. No
    row written before those fields existed can say so, so the honest split is
    by presence, never by assumption.
    """
    inside, outside = [], []
    w = (wallet or "").lower()
    for r in rows:
        rc = r.get("chain_id")
        rw = str(r.get("wallet") or r.get("policy_wallet") or "").lower()
        if rc is None or not rw:
            outside.append(r)
        elif (chain_id is None or int(rc) == int(chain_id)) and (not w or rw == w):
            inside.append(r)
        else:
            outside.append(r)
    return inside, outside


@dataclass
class Finding:
    """One disagreement, with enough to act on it."""

    kind: str
    decision_hash: str
    detail: str
    block: int | None = None
    tx: str = ""
    amount_usdc: float | None = None
    vendor: str = ""
    category: str = ""
    intent: str = ""

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "decision_hash": self.decision_hash,
            "detail": self.detail,
            "block": self.block,
            "tx": self.tx,
            "amount_usdc": self.amount_usdc,
            "vendor": self.vendor,
            "category": self.category,
            "intent": self.intent,
        }


@dataclass
class Reconciliation:
    """The verdict, plus the chain-only picture that needs no tape at all."""

    counts: Counter = field(default_factory=Counter)
    findings: list[Finding] = field(default_factory=list)
    chain: dict = field(default_factory=dict)
    reach: dict = field(default_factory=dict)
    unscoped_rows: int = 0
    scoped_rows: int = 0

    @property
    def alarms(self) -> list[Finding]:
        """The findings a human must look at, worst first."""
        order = {"paid_against_decision": 0, "unexplained": 1, "recorded_unseen": 2}
        return sorted(
            (f for f in self.findings if f.kind in order),
            key=lambda f: (order[f.kind], -(f.amount_usdc or 0.0)),
        )

    @property
    def clean(self) -> bool:
        return not self.alarms

    def as_dict(self) -> dict:
        return {
            "clean": self.clean,
            "counts": dict(self.counts),
            "alarms": [f.as_dict() for f in self.alarms],
            "chain": self.chain,
            "reach": self.reach,
            "rows": {"scoped": self.scoped_rows, "unscoped": self.unscoped_rows},
        }


def chain_picture(spends: list) -> dict:
    """Everything derivable from the log alone — no tape, no server, no trust.

    This is the part of the audit that still works when the tape is gone, which
    on a disk-less host is the normal case rather than the disaster case.
    """
    if not spends:
        return {"spends": 0}
    by_cat: Counter = Counter()
    by_actor: Counter = Counter()
    by_payee: Counter = Counter()
    for s in spends:
        by_cat[s.category] += s.amount_usdc
        by_actor[s.actor.lower()] += s.amount_usdc
        by_payee[s.to.lower()] += s.amount_usdc
    owner = sum(1 for s in spends if s.owner_approved)
    util = [s.utilisation for s in spends if s.utilisation is not None]
    total = sum(s.amount_usdc for s in spends)
    return {
        "spends": len(spends),
        "total_usdc": round(total, 6),
        "first_block": spends[0].block,
        "last_block": spends[-1].block,
        # Which rung authorized the money, straight from the event. The
        # escalation threshold is only real if it can be counted, and this is
        # the only place it can be counted without believing our own records.
        "owner_approved": owner,
        "agent_only": len(spends) - owner,
        "owner_approved_share": round(owner / len(spends), 4),
        "peak_utilisation": round(max(util), 4) if util else None,
        "min_headroom_usdc": round(min(s.headroom_usdc for s in spends), 6),
        "by_category": {k: round(v, 6) for k, v in by_cat.most_common()},
        "by_actor": {k: round(v, 6) for k, v in by_actor.most_common()},
        "by_payee": {k: round(v, 6) for k, v in by_payee.most_common(10)},
        "payees": len(by_payee),
        # A single payee taking everything is not wrong, but it is worth seeing.
        "payee_concentration": round(max(by_payee.values()) / total, 4) if total else None,
    }


def reconcile(
    rows: list[dict],
    spends: list,
    *,
    chain_id: int | None = None,
    wallet: str | None = None,
    reach: dict | None = None,
) -> Reconciliation:
    """Join the tape to the chain and name every disagreement.

    ``rows`` comes from ``statement.read_decisions``; ``spends`` and ``reach``
    from ``acr_oracle_client.spend_ledger.SpendLedger.spends``. ``reach`` is
    carried through untouched because a verdict over a range that was only
    partly read is not a verdict, and the caller must be able to see which it
    has.
    """
    scoped, unscoped = scope_rows(rows, chain_id, wallet)
    out = Reconciliation(
        chain=chain_picture(spends),
        reach=dict(reach or {}),
        unscoped_rows=len(unscoped),
        scoped_rows=len(scoped),
    )

    on_chain = {s.decision_hash.lower(): s for s in spends}
    tape: dict[str, dict] = {}
    for r in scoped:
        tape[row_hash(r).lower()] = r

    for r in scoped:
        h = row_hash(r).lower()
        s = on_chain.get(h)
        intent = str(r.get("intent") or "")
        paying = intent in _PAYING
        if s is not None and paying:
            out.counts["settled"] += 1
        elif s is not None and not paying:
            out.counts["paid_against_decision"] += 1
            out.findings.append(
                Finding(
                    "paid_against_decision", h,
                    f"the decision said {intent!r} and {s.amount_usdc} USDC moved anyway",
                    block=s.block, tx=s.tx, amount_usdc=s.amount_usdc,
                    vendor=str(r.get("vendor") or ""), category=str(r.get("category") or ""),
                    intent=intent,
                )
            )
        elif paying and r.get("tx"):
            out.counts["recorded_unseen"] += 1
            out.findings.append(
                Finding(
                    "recorded_unseen", h,
                    "the row records a transaction the chain does not show in this range",
                    tx=str(r.get("tx") or ""), amount_usdc=r.get("paid_usdc"),
                    vendor=str(r.get("vendor") or ""), category=str(r.get("category") or ""),
                    intent=intent,
                )
            )
        elif paying:
            out.counts["decided_unsent"] += 1
        else:
            out.counts["consistent"] += 1

    for h, s in on_chain.items():
        if h in tape:
            continue
        out.counts["unexplained"] += 1
        out.findings.append(
            Finding(
                "unexplained", h,
                f"{s.amount_usdc} USDC left the wallet with no decision recorded for it",
                block=s.block, tx=s.tx, amount_usdc=s.amount_usdc,
                category=s.category,
            )
        )

    out.counts["unscoped"] = len(unscoped)
    return out
