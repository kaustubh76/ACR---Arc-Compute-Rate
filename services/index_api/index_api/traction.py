"""The traction numbers, derived — never maintained.

Canteen's submission form asks three things: how many businesses you have
onboarded, how much value the agent moved, and what problems you are solving.
Their judging note adds the suspicion this file exists to answer: *"Genuine
usage during the event window… volume you can point to."* And the FAQ: *"What
doesn't count is a synthetic dataset."*

So every figure here is computed from the registry and the decision log at
request time. There is no hand-maintained total anywhere, which is the only way
a number and the rows beside it cannot drift apart — and drifting is exactly how
a traction claim stops being checkable.

THE DISTINCTION THAT KEEPS THIS HONEST, and it is the whole file:

    moved_usdc     what the OPERATOR actually paid out. Today this is zero for
                   the fleet, because no PolicyWallet is funded yet and every
                   decision was a dry run. Zero is the true answer and it is
                   reported as zero.
    priced_usdc    what the operator assessed: metered, benchmarked, decided on.
                   Real work on real bills, and a different claim.
    recoverable    overpay found against an OBSERVED cheaper offer, with the
                   seller named on every one.

The fleet's 0.325 USDC of historical settlements were moved by the buyer agent
before this operator existed. Counting them as "value the agent moved" would be
the single most tempting lie available here, and it would be a lie: the operator
priced them, it did not pay them.

MAINNET AND TESTNET ARE NEVER SUMMED. Canteen say test USDC counts and mainnet
counts more, which only means anything if the two are reported apart.
"""

from __future__ import annotations

import time
from collections import defaultdict

from .businesses import Business, counts, real
from .operator import ESCALATE, HOLD, PAY, REFUSE, REROUTE
from .statement import read_decisions, summarise

#: Intents the agent reached on its own authority.
_DECIDED = (PAY, HOLD, REROUTE, REFUSE)


def _per_business(b: Business) -> dict:
    rows = read_decisions(business=b.slug)
    s = summarise(rows)
    return {
        "slug": b.slug,
        "label": b.public_name,
        "tier": b.tier,
        "chain": b.chain,
        "consented": b.consented,
        "spends": bool(b.policy_wallet),
        "decisions": s["decisions"],
        "decided": s["decided"],
        "escalated": s["escalated"],
        # What the operator actually paid out, and what it only assessed.
        "moved_usdc": s["paid_usdc"],
        "priced_usdc": round(sum(float(r.get("billed_usdc") or 0.0) for r in rows), 6),
        "recoverable_usdc": s["saved_usdc"],
        "discrepancies": s["consumption_discrepancies"],
        "unmetered": s["unmetered"],
        # A per-business ledger anyone can open and check the arithmetic in.
        "ledger": f"/operator/ledger/{b.slug}",
        "statement": f"/operator/statement/{b.slug}",
    }


def build_traction(registry: tuple[Business, ...] | None = None, now: float | None = None) -> dict:
    """Every traction figure, computed from the rows that justify it."""
    # Through `real()`, so a sandbox business cannot move a single figure on
    # this page. It demonstrates the UI; it is not usage.
    reg = real(registry)
    rows = [_per_business(b) for b in reg]

    by_chain: dict[str, dict[str, float]] = defaultdict(
        lambda: {"moved_usdc": 0.0, "priced_usdc": 0.0, "recoverable_usdc": 0.0}
    )
    intents: dict[str, int] = defaultdict(int)
    decided = escalated = discrepancies = unmetered = decisions = 0

    for r in rows:
        c = by_chain[r["chain"]]
        c["moved_usdc"] += r["moved_usdc"]
        c["priced_usdc"] += r["priced_usdc"]
        c["recoverable_usdc"] += r["recoverable_usdc"]
        decisions += r["decisions"]
        decided += r["decided"]
        escalated += r["escalated"]
        discrepancies += r["discrepancies"]
        unmetered += r["unmetered"]

    for b in reg:
        for d in read_decisions(business=b.slug):
            intents[str(d.get("intent") or "")] += 1

    return {
        "as_of": now if now is not None else time.time(),
        # "How many businesses have you onboarded"
        "businesses": counts(reg),
        # "How much value did the agent move" — apart by chain, never summed,
        # and `moved` is kept distinct from `priced`.
        "by_chain": {
            chain: {k: round(v, 6) for k, v in vals.items()}
            for chain, vals in sorted(by_chain.items())
        },
        # "What problems are you solving for them"
        "work": {
            "decisions": decisions,
            "decided": decided,
            "escalated": escalated,
            "by_intent": {k: intents.get(k, 0) for k in (PAY, HOLD, REROUTE, ESCALATE, REFUSE)},
            "consumption_discrepancies": discrepancies,
            "unmetered": unmetered,
        },
        "per_business": rows,
        "note": (
            "Every figure is computed from the registry and the decision log at "
            "request time; nothing here is maintained by hand. `moved_usdc` is "
            "what the operator paid out, which is not the same claim as "
            "`priced_usdc`, what it assessed. Mainnet and testnet are never summed."
        ),
    }
