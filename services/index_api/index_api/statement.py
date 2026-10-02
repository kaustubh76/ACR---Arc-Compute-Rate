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
import os
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path

from .businesses import Business, resolve
from .operator import ESCALATE, HOLD, LOG_PATH, PAY, REFUSE, REROUTE

log = logging.getLogger("index_api.statement")

#: Most recent decisions carried on the statement. A statement is a summary; the
#: full ledger is the log and the chain.
RECENT_LIMIT = 50

#: How long the market context may take before the statement goes without it.
#:
#: MEASURED: `payer_tca` costs ~7 SECONDS on a cold cache, because it reaches a
#: live subgraph, and then caches. The proxy in front of this endpoint times out
#: at 5s — so the first visitor after any press restart saw "this statement
#: could not be read" for a statement whose decisions were already in hand after
#: 1.3 ms. On a free tier that restarts, that is the common case, not the edge.
#:
#: The context is explicitly optional: it is basis points beside a figure, it
#: already has an `available: false` path with a reason, and `anchors/GAP.md` is
#: why it can never be the headline. Something optional must not be able to fail
#: the thing it decorates.
TCA_BUDGET_S = float(os.environ.get("ACR_STATEMENT_TCA_BUDGET_S", "2"))

#: The committed decision archive, inside the package.
#:
#: Same two-tier shape the receipts use, and for the same reason: `data/` is
#: untracked AND in `.dockerignore`, so a log written only there is present in
#: development and absent in production — a statement that shows a business's
#: decisions locally and nothing at all on the deployed site. The archive ships
#: in the image; the runtime log accumulates beside it.
ARCHIVE_PATH = Path(__file__).with_name("operator_decisions.jsonl")

#: The SANDBOX's decisions, in their own file.
#:
#: They could live in the archive beside the real ones — every row carries its
#: `business` and `read_decisions` filters on it — but then somebody opening
#: `operator_decisions.jsonl` to audit what the agent really did would be
#: reading a mixture. Two files cost one extra read and remove that question
#: entirely.
SANDBOX_ARCHIVE_PATH = Path(__file__).with_name("operator_decisions.sandbox.jsonl")


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
        rows = (
            _read_one(ARCHIVE_PATH)
            + _read_one(SANDBOX_ARCHIVE_PATH)
            + _read_one(Path(LOG_PATH))
        )

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


def _market_card(tca_fn, treasury: str, days: int) -> dict:
    """The market context, or a stated reason there isn't one, within a budget.

    Run on a worker thread because `payer_tca` is synchronous and talks to a
    subgraph. A thread that outlives the budget is abandoned rather than waited
    on: its result would arrive after the response, and the caching inside
    `tca.py` means the NEXT reader gets it for free. Nothing is cancelled
    because nothing needs to be — it is a read.

    An exception is `UNAVAILABLE` rather than a raise: a statement whose
    decisions are all in hand must not 500 because an optional decoration
    failed.
    """
    # NOT a `with` block. `ThreadPoolExecutor.__exit__` calls
    # `shutdown(wait=True)`, which blocks on the very thread the timeout just
    # abandoned — measured: the budget fired at 2s and the function still took
    # 6.3s, so the timeout looked right and fixed nothing.
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="statement-tca")
    try:
        fut = pool.submit(tca_fn, treasury, days=days)
        return fut.result(timeout=TCA_BUDGET_S) or {}
    except FutureTimeout:
        log.info("statement: market context exceeded %.1fs, going without", TCA_BUDGET_S)
        return {"available": False, "reason": "SLOW"}
    except Exception as exc:  # noqa: BLE001
        log.warning("statement: market context unavailable (%s)", exc)
        return {"available": False, "reason": "UNAVAILABLE"}
    finally:
        # Let the worker finish on its own time: its answer warms `tca.py`'s
        # cache, so the next reader gets the context for free. Nothing is
        # cancelled because nothing needs to be — it is a read.
        pool.shutdown(wait=False)


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
        card = _market_card(tca_fn, b.treasury, days)
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
