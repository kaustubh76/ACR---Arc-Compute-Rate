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

#: The committed decision archive, inside the package.
#:
#: Same two-tier shape the receipts use, and for the same reason: `data/` is
#: untracked AND in `.dockerignore`, so a log written only there is present in
#: development and absent in production — a statement that shows a business's
#: decisions locally and nothing at all on the deployed site. The archive ships
#: in the image; the runtime log accumulates beside it.
ARCHIVE_PATH = Path(__file__).with_name("operator_decisions.jsonl")


def _read_one(target: Path) -> list[dict]:
    """One JSONL file's rows, tolerantly.

    A missing file is an empty list, not an error. A malformed line is skipped
    rather than taken as the end of the file: an interrupted write leaves half a
    line, and treating that as EOF would silently drop every decision behind it.
    """
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except Exception as exc:
        log.warning("statement: %s unreadable (%s)", target.name, exc)
        return []
    rows: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def read_decisions(
    path: str | Path | None = None,
    business: str = "",
    since: float = 0.0,
    limit: int = 1_000,
) -> list[dict]:
    """The operator's decisions, newest last: the archive, then the live log.

    An explicit ``path`` reads only that file — tests and one-off inspections
    want exactly what they name. Otherwise both tiers are read and deduped, so a
    decision that has been archived does not appear twice once the live log is
    rotated into it.

    Deduped on the ROW'S WHOLE CONTENT, not on a composite of a few fields. A
    guessed key collapses rows it should not: an (obligation_id, at, intent) key
    merged two genuinely different decisions in the first version of this, which
    is a worse failure than showing a duplicate. Identical content is the only
    thing that can safely be treated as one decision, and it is exactly what the
    archive-plus-live overlap produces.
    """
    if path is not None:
        rows = _read_one(Path(path))
    else:
        rows = _read_one(ARCHIVE_PATH) + _read_one(Path(LOG_PATH))

    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        if business and (row.get("business") or "") != business:
            continue
        if float(row.get("at") or 0.0) < since:
            continue
        key = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    out.sort(key=lambda r: float(r.get("at") or 0.0))
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


def pending_escalations(decisions: list[dict]) -> list[dict]:
    """The escalations still waiting on a person, newest first.

    An escalation is NOT resolved by being old; it is resolved by a later
    decision about the same obligation. The log is append-only, so approving one
    appends a payment rather than editing the escalation — and a queue that
    filtered on `intent == "escalate"` alone would keep showing an obligation the
    owner paid an hour ago, which is the one thing an action queue must never do.

    Resolution is per obligation id. A second escalation of the same obligation
    (a retry that stopped again) does not resolve the first: both are the same
    id, and only a non-escalating outcome clears it.
    """
    resolved = {
        d.get("obligation_id")
        for d in decisions
        if d.get("intent") != ESCALATE and d.get("obligation_id")
    }
    seen: set[str] = set()
    out: list[dict] = []
    for d in reversed(decisions):
        if d.get("intent") != ESCALATE:
            continue
        oid = d.get("obligation_id") or ""
        if oid in resolved or oid in seen:
            continue
        # One row per obligation: re-escalating the same bill is the same item
        # of work, not two.
        seen.add(oid)
        out.append(d)
    return out


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

    escalations = pending_escalations(decisions)[:RECENT_LIMIT]

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
