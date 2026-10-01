"""The Spend Statement — what the owner reads, and what it is allowed to claim.

THE ONE SEPARATION THIS FILE EXISTS TO ENFORCE. Two different benchmarks are in
play and only one of them may be denominated in dollars:

  SAVINGS, in USDC, come from the operator's own decision log, where every
  figure is the gap between a price billed and a price another seller was
  actually offering for the same service. Real money, available elsewhere.

  MARKET CONTEXT, in basis points only, comes from ``payer_tca``, which measures
  against the ACR arrival print. ``anchors/GAP.md`` records that print's
  reference level sitting 20x to 1159x off real market prices, so its bp figures
  are meaningful (they are exactly scale-invariant — GAP.md re-anchored ACR-INF
  667x without the error moving) while its **USDC** figures are not.

So ``payer_tca``'s ``overpaid_usdc`` is deliberately NOT forwarded. It is a real
number about a synthetic scale, and on an owner-facing page it would read as
money. The bp figures from the same call are forwarded, labelled as context.

If that distinction is ever collapsed — one "total saved" adding the two — the
statement starts making a claim the repo's own anchor report contradicts, and
that report is public.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from .businesses import Business, resolve
from .operator import ESCALATE, HOLD, LOG_PATH, PAY, REFUSE, REROUTE

log = logging.getLogger("index_api.statement")

#: Most recent decisions carried on the statement. A statement is a summary; the
#: full ledger is the log and the chain.
RECENT_LIMIT = 50


def read_decisions(
    path: str | Path | None = None,
    business: str = "",
    since: float = 0.0,
    limit: int = 1_000,
) -> list[dict]:
    """The operator's own decision log, newest last.

    A missing log is an empty list, not an error: a business onboarded ten
    minutes ago has made no decisions, and that is the correct reading. A
    malformed line is skipped rather than taken as the end of the file — an
    interrupted write must not truncate the history behind it.
    """
    target = Path(path) if path else Path(LOG_PATH)
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except Exception as exc:
        log.warning("statement: decision log unreadable (%s)", exc)
        return []

    out: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        if business and (row.get("business") or "") != business:
            continue
        if float(row.get("at") or 0.0) < since:
            continue
        out.append(row)
    return out[-limit:] if limit else out


def summarise(decisions: list[dict]) -> dict:
    """The counts and the one dollar figure that is defensible.

    ``decisions_vs_escalations`` is the pair Canteen's traction questions ask
    for, kept as two numbers rather than a ratio: a ratio hides how much the
    agent actually did, and the interesting failure is a high ratio over three
    decisions.
    """
    by_intent = {k: 0 for k in (PAY, HOLD, REROUTE, ESCALATE, REFUSE)}
    saved = 0.0
    paid = 0.0
    discrepancies = 0
    unmetered = 0

    for d in decisions:
        intent = str(d.get("intent") or "")
        if intent in by_intent:
            by_intent[intent] += 1
        # Only a reroute recovers money: it names a seller who was offering the
        # same service for less. An escalation might save more and might save
        # nothing, and which it was is not known until a human acts.
        if intent == REROUTE:
            s = d.get("saving_usdc")
            if isinstance(s, (int, float)) and s > 0:
                saved += float(s)
        if intent == PAY:
            p = d.get("paid_usdc")
            if isinstance(p, (int, float)):
                paid += float(p)
        disc = d.get("discrepancy")
        if isinstance(disc, (int, float)) and disc > 0:
            discrepancies += 1
        if "unmetered" in str(d.get("rule") or ""):
            unmetered += 1

    acted = by_intent[PAY] + by_intent[HOLD] + by_intent[REROUTE] + by_intent[REFUSE]
    return {
        "decisions": len(decisions),
        "by_intent": by_intent,
        # The agent's own authority vs a human's, side by side.
        "decided": acted,
        "escalated": by_intent[ESCALATE],
        "paid_usdc": paid,
        # Recoverable, because another seller was offering it.
        "saved_usdc": saved,
        "consumption_discrepancies": discrepancies,
        "unmetered": unmetered,
    }


def _budgets(business: Business, policy_for) -> list[dict]:
    """Each category's live budget, read from the contract.

    An empty list means one of two different things and the caller is told
    which: no PolicyWallet (the business is being measured, not spent for) or no
    categories configured yet.
    """
    if policy_for is None or not business.policy_wallet:
        return []
    client = policy_for(business)
    if client is None:
        return []
    out = []
    for category in business.categories:
        b = client.budget(category)
        if b is None:
            out.append({"category": category, "configured": False})
            continue
        out.append({**b, "configured": True})
    return out


def build_statement(
    ident: str,
    *,
    days: int = 7,
    registry: tuple[Business, ...] | None = None,
    tca_fn=None,
    policy_for=None,
    log_path: str | Path | None = None,
    now: float | None = None,
) -> dict | None:
    """The owner-facing statement for one business, or None if unknown.

    Every collaborator is injected so the whole page is testable without a
    chain, a subgraph or a wallet — the same reason ``decide`` is pure.
    """
    t = now if now is not None else time.time()
    b = resolve(ident, registry)
    if b is None:
        return None

    since = t - days * 86_400
    decisions = read_decisions(log_path, business=b.slug, since=since)
    summary = summarise(decisions)

    # Market context, in bp only. See the module docstring for why the USDC
    # figures from this call are not forwarded.
    context: dict = {"available": False, "reason": "not requested"}
    if tca_fn is not None:
        card = tca_fn(b.treasury, days=days) or {}
        if card.get("available"):
            context = {
                "available": True,
                "purchases": card.get("purchases"),
                "benchmarked": card.get("benchmarked"),
                "spent_usdc": card.get("spent_usdc"),
                "vw_slippage_bp": card.get("vw_slippage_bp"),
                "basis": "ACR arrival print, bp only",
                "note": (
                    "bp against the published index, which is scale-invariant. "
                    "USDC savings on this statement come from observed quotes "
                    "instead; see anchors/GAP.md."
                ),
            }
        else:
            context = {
                "available": False,
                "reason": card.get("reason") or "no tape for this payer",
            }

    escalations = [
        d for d in reversed(decisions) if d.get("intent") == ESCALATE
    ][:RECENT_LIMIT]

    return {
        "business": b.as_public_dict(),
        "period_days": days,
        "as_of": t,
        "spend": summary,
        "budgets": _budgets(b, policy_for),
        "spends": bool(b.policy_wallet),
        # What the owner has to act on. First, because it is the only part of
        # the statement that is waiting on them.
        "escalations": escalations,
        "recent": list(reversed(decisions))[:RECENT_LIMIT],
        "market_context": context,
    }
