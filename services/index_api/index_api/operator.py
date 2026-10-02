"""The spend operator's decision — one obligation, start to finish.

RFB 4 asks for "at least one complete business workflow, run by the agent from
start to finish", and for the agent to "know which decisions are not its to
make". This module is that decision, and it is deliberately a PURE FUNCTION:
``decide()`` takes an obligation, what the meter counted, what the market is
charging and what the budget has left, and returns a record. It moves no money
and reads no chain, so every branch below is reachable from a test rather than
from a funded wallet — the same reason ``apps/agent/src/reroute.ts`` keeps
``applyReroute`` pure.

THE ORDER OF REFUSALS IS THE DESIGN. ``scripts/hedger.py`` already learned this:
checks run cheapest-and-most-damning first, each one names itself, and a check
that cannot be evaluated is a refusal rather than a pass. The order here is

    1 duplicate            we already paid this
    2 payable at all       a payee, and an amount
    3 the meter            did we consume what they billed for
    4 benchmarked          is there a market price to judge against
    5 the price            at par, over par, cheaper elsewhere
    6 the timing           due now, or worth holding
    7 the budget           per-transaction limit, then the period cap

and it is not interchangeable. Pricing an invoice we never owed is wasted work;
rerouting one that is a duplicate pays a stranger twice. The meter comes before
the price because a bill for work nobody did is not a pricing question — that is
Prior Art #06's whole point, and the reason this agent is named after the
official who kept the standard measure rather than after a bargain hunter.

REFUSE, NEVER CLAMP, and never silently. Every outcome carries a ``rule``: one
line naming the check that fired. ``PolicyWallet`` stores the hash of this whole
record before the money moves, so the reasoning is committed rather than
reconstructed afterwards — ``euthyna``, Prior Art #01.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field

from .par import MATERIAL_BP, Par, assess

log = logging.getLogger("index_api.operator")

#: How far the vendor's reported quantity may exceed our own count before the
#: bill stops being a rounding difference and becomes a question for a human.
#: Deliberately small: the meter is the product's whole claim, and a generous
#: tolerance is a way of not looking.
METER_TOLERANCE = float(os.environ.get("ACR_OPERATOR_METER_TOLERANCE", "0.02"))

#: The most the operator will pay for something it could not price. An
#: unbenchmarked invoice is not refused outright — a brand-new vendor has no
#: market yet and somebody still has to be paid — but it is capped, so the
#: unpriceable case cannot quietly become the expensive one.
UNBENCHMARKED_MAX_USDC = float(os.environ.get("ACR_OPERATOR_UNBENCHMARKED_MAX", "1.0"))

#: Pay this many seconds ahead of the due date at the earliest, unless an
#: early-pay discount beats holding the cash. Net-30 exists because payments
#: used to be expensive; at a cent a transaction the calendar stops being the
#: reason to wait, so the default is short rather than zero.
PAY_WINDOW_S = float(os.environ.get("ACR_OPERATOR_PAY_WINDOW_S", str(3 * 86_400)))

#: Where decisions are written. Like ``hedger.py``'s log this is a DIAGNOSTIC:
#: the checkable record is the signed receipt and the on-chain decision hash.
LOG_PATH = os.environ.get("ACR_OPERATOR_LOG_PATH", "data/operator_decisions.jsonl")

#: The fields `as_record` leaves out of the hash: the payment's own results,
#: which do not exist yet when the commitment is made.
#:
#: Named ONCE because three places need to agree — the writer, a reviewer
#: re-deriving the hash from a log row, and the approve path paying an
#: obligation somebody escalated hours ago. If any of them strips a different
#: set, the record stops matching its own commitment and the only reading left
#: is "this was edited", which would be false.
UNHASHED = ("tx", "paid_usdc")

#: Intents. ``reroute`` and ``escalate`` are not failures — they are the two
#: ways this agent is useful without being reckless.
PAY = "pay"
HOLD = "hold"
REROUTE = "reroute"
ESCALATE = "escalate"
REFUSE = "refuse"


@dataclass(frozen=True)
class Obligation:
    """Something the business owes, however it arrived."""

    obligation_id: str
    vendor: str
    billed_usdc: float
    #: The business whose money this is, by registry slug. Part of the decision
    #: and therefore part of the hash: a record that does not say whose treasury
    #: paid is not a record anybody can audit, and with one wallet per business
    #: it is the only field that distinguishes two otherwise identical invoices.
    business: str = ""
    category: str = "general"
    #: ``x402`` a machine service we called · ``invoice`` a vendor bill ·
    #: ``milestone`` contractor work · ``subscription`` a renewal.
    kind: str = "invoice"
    resource: str = ""
    #: What the vendor says we consumed, in the service's own unit.
    vendor_quantity: float | None = None
    due_at: float | None = None
    #: The vendor's own reference, for duplicate detection.
    invoice_ref: str = ""
    #: An early-payment discount, as a fraction (0.02 == 2% off).
    early_pay_discount: float = 0.0


@dataclass
class ObligationDecision:
    """The record. ``billed · metered · par · paid · rule · tx``, plus why."""

    at: float
    obligation_id: str
    vendor: str
    category: str
    billed_usdc: float
    intent: str
    #: One line naming the check that fired. The thing a reviewer reads first.
    rule: str
    #: The business whose money this is, by registry slug.
    business: str = ""
    resource: str = ""
    metered_quantity: float | None = None
    vendor_quantity: float | None = None
    #: Positive == the vendor billed for more than we counted.
    discrepancy: float | None = None
    par_usdc: float | None = None
    best_usdc: float | None = None
    over_par_bp: float | None = None
    #: Recoverable, because somebody is offering it at that price.
    saving_usdc: float | None = None
    reroute_to: str = ""
    escalated: bool = False
    paid_usdc: float = 0.0
    tx: str | None = None
    notes: list[str] = field(default_factory=list)

    def as_record(self) -> dict:
        """The dict that gets hashed into ``PolicyWallet``.

        The payment's own results are excluded: the commitment is made BEFORE the
        money moves, so a record including its own transaction hash could never
        be hashed in time. Everything the decision rested on is in here, which is
        what a reviewer replays.
        """
        return {k: v for k, v in asdict(self).items() if k not in UNHASHED}


def hashable_record(row: dict) -> dict:
    """The decision as it was HASHED, recovered from a log row.

    `log_decision` writes the whole decision including the payment's results;
    `as_record` hashed it without them. Anything re-deriving that hash later —
    verifying a receipt, or paying an obligation a human has just approved — has
    to strip the same fields, so it strips them through here.
    """
    return {k: v for k, v in (row or {}).items() if k not in UNHASHED}


def log_decision(d: ObligationDecision, path: str | None = None) -> None:
    """Append one decision. Never raises: a full disk must not stop a payment
    that already cleared policy, and the authoritative record is on chain."""
    target = path or LOG_PATH
    try:
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(d), default=str) + "\n")
    except Exception as exc:  # pragma: no cover - disk dependent
        log.warning("operator: could not write the decision log (%s)", exc)


# --- the meter (Prior Art #06) ---------------------------------------------


def meter_quantity(
    receipts: list[dict], vendor: str, resource: str, since: float = 0.0
) -> float | None:
    """Our OWN count of what we consumed from this vendor for this resource.

    Independent because it is not the vendor's number: these are the operator's
    own settlement receipts, each one a payment it made and can prove. "The
    agent's own cup", in the prior-art's terms.

    ``None`` when we have no record at all, which is NOT zero. Zero would assert
    we consumed nothing and make every bill look fraudulent; ``None`` says we
    cannot check, and the caller escalates instead of accusing.
    """
    v = (vendor or "").lower()
    seen = False
    total = 0.0
    for r in receipts or []:
        if (r.get("seller") or "").lower() != v:
            continue
        if resource and r.get("resource") != resource:
            continue
        if float(r.get("settled_at") or 0.0) < since:
            continue
        seen = True
        q = r.get("quantity")
        if isinstance(q, (int, float)) and q > 0:
            total += float(q)
    return total if seen else None


def _payable_to(vendor: str) -> bool:
    """Is there somebody to pay?

    The zero address is the shape this fails in practice: an unparsed payee
    field, or a vendor record with the address missing, renders as
    0x000…0 and a payment to it is burnt rather than refused. A malformed
    non-hex string is also not a payee — it is caught here rather than by
    ``int(..., 16)`` raising three checks later.
    """
    v = (vendor or "").strip()
    if not v:
        return False
    if v.startswith("0x"):
        try:
            return int(v, 16) != 0
        except ValueError:
            return False
    return True


def is_duplicate(ob: Obligation, settled_refs: set[str]) -> bool:
    """Have we already paid this?

    Matched on the obligation id AND the vendor's own reference, because the two
    duplicate shapes differ: a re-sent invoice keeps the vendor's ref and gets a
    new id from us, while a retried call keeps our id. Checking one catches half.
    """
    if ob.obligation_id and ob.obligation_id in settled_refs:
        return True
    return bool(ob.invoice_ref) and ob.invoice_ref in settled_refs


# --- the decision ----------------------------------------------------------


def decide(
    ob: Obligation,
    *,
    par: Par | None = None,
    metered_quantity: float | None = None,
    settled_refs: set[str] | None = None,
    remaining_usdc: float | None = None,
    per_tx_limit_usdc: float | None = None,
    now: float | None = None,
    meter_tolerance: float = METER_TOLERANCE,
    unbenchmarked_max_usdc: float = UNBENCHMARKED_MAX_USDC,
    pay_window_s: float = PAY_WINDOW_S,
    material_bp: float = MATERIAL_BP,
) -> ObligationDecision:
    """One obligation in, one record out. Pure."""
    t = now if now is not None else time.time()
    refs = settled_refs or set()

    d = ObligationDecision(
        at=t,
        obligation_id=ob.obligation_id,
        vendor=ob.vendor,
        category=ob.category,
        billed_usdc=ob.billed_usdc,
        business=ob.business,
        resource=ob.resource,
        intent=REFUSE,
        rule="",
        metered_quantity=metered_quantity,
        vendor_quantity=ob.vendor_quantity,
    )

    # 1 — already paid. First, because every later check would be work done on
    # behalf of a payment that must not happen.
    if is_duplicate(ob, refs):
        d.intent, d.rule = REFUSE, "duplicate: this reference has already settled"
        return d

    # 2 — payable at all.
    if not _payable_to(ob.vendor):
        d.intent, d.rule = REFUSE, "no payee: nothing to pay, and no one to pay it to"
        return d
    if ob.billed_usdc <= 0:
        d.intent, d.rule = REFUSE, "no amount: a bill for nothing is not a bill"
        return d

    # 3 — the meter, before the price. A bill for work nobody did is not a
    # pricing question.
    if ob.vendor_quantity is not None:
        if metered_quantity is None:
            d.intent, d.escalated = ESCALATE, True
            d.rule = "unmetered: we hold no record of consuming this, so we cannot check the bill"
            return d
        d.discrepancy = ob.vendor_quantity - metered_quantity
        allowed = abs(metered_quantity) * meter_tolerance
        if d.discrepancy > allowed:
            d.intent, d.escalated = ESCALATE, True
            d.rule = (
                f"metered below billed: they billed {ob.vendor_quantity:g}, "
                f"we counted {metered_quantity:g}"
            )
            return d
        if d.discrepancy < -allowed:
            d.notes.append(
                f"they billed {ob.vendor_quantity:g} under our count of {metered_quantity:g}"
            )

    # 4 and 5 — the price, against observed quotes for the same service.
    verdict = assess(ob.billed_usdc, par, material_bp) if par is not None else None
    if verdict is None or not verdict["benchmarked"]:
        reason = (verdict or {}).get("reason") or "NO_PAR"
        if ob.billed_usdc > unbenchmarked_max_usdc:
            d.intent, d.escalated = ESCALATE, True
            d.rule = (
                f"unbenchmarked ({reason}) and above the "
                f"{unbenchmarked_max_usdc:g} USDC ceiling for a price we cannot check"
            )
            return d
        d.notes.append(f"unbenchmarked ({reason}), under the ceiling")
    else:
        d.par_usdc = verdict["par_usdc"]
        d.best_usdc = verdict["best_usdc"]
        d.over_par_bp = verdict["over_par_bp"]
        d.saving_usdc = verdict["saving_usdc"]

        if verdict["verdict"] == "over_par":
            cheaper = verdict["best_seller"]
            # A cheaper seller who is the vendor itself is not a reroute; `par`
            # already excludes the biller, so reaching here means a real third
            # party is offering it for less.
            if cheaper and cheaper.lower() != ob.vendor.lower():
                d.intent, d.reroute_to = REROUTE, cheaper
                d.rule = (
                    f"over par by {verdict['over_par_bp']:.0f} bp: "
                    f"{verdict['best_usdc']:g} is on offer, saving "
                    f"{verdict['saving_usdc']:g} USDC"
                )
                return d
            d.intent, d.escalated = ESCALATE, True
            d.rule = f"over par by {verdict['over_par_bp']:.0f} bp with no alternative seller"
            return d

    # 6 — the timing. Paying early costs the cash; paying late costs the
    # discount. Only one of those is recoverable, so the discount wins when it
    # exists and the calendar wins when it does not.
    if ob.due_at is not None and ob.early_pay_discount <= 0:
        if ob.due_at - t > pay_window_s:
            d.intent = HOLD
            d.rule = (
                f"not due for {int((ob.due_at - t) / 86_400)} days and no early-pay "
                "discount, so the cash is worth more here"
            )
            return d
    elif ob.early_pay_discount > 0:
        d.notes.append(f"paying early for a {ob.early_pay_discount * 100:g}% discount")

    # 7 — the budget. Last, because it is the only check whose answer the
    # business can change by deciding to, and because PolicyWallet enforces it
    # again on chain regardless of what this function concluded.
    if per_tx_limit_usdc is not None and ob.billed_usdc >= per_tx_limit_usdc:
        d.intent, d.escalated = ESCALATE, True
        d.rule = (
            f"{ob.billed_usdc:g} USDC is at or above the "
            f"{per_tx_limit_usdc:g} per-payment limit, so the owner signs this one"
        )
        return d
    if remaining_usdc is not None and ob.billed_usdc > remaining_usdc:
        d.intent, d.escalated = ESCALATE, True
        d.rule = (
            f"over budget: {ob.billed_usdc:g} USDC against {remaining_usdc:g} left "
            f"in {ob.category} this period"
        )
        return d

    d.intent = PAY
    d.rule = _pay_rule(d, verdict)
    return d


def _pay_rule(d: ObligationDecision, verdict: dict | None) -> str:
    """Why this payment was made, in one line a reviewer can act on."""
    if verdict and verdict.get("benchmarked"):
        bp = verdict["over_par_bp"]
        where = "at par" if abs(bp) < MATERIAL_BP else f"{bp:+.0f} bp against par"
        return f"{where} on {verdict['sellers']} observed sellers, inside budget"
    return "unbenchmarked but under the ceiling, inside budget"


# --- the driver ------------------------------------------------------------
# Impure, and kept thin on purpose: everything worth arguing with lives in
# `decide` above, where a test can reach it. `hedger.py` is the precedent for
# holding the pure helpers and the loop in one file.


def run_obligation(
    ob: Obligation,
    *,
    receipts: list[dict],
    catalog: dict,
    policy=None,
    settled_refs: set[str] | None = None,
    since: float = 0.0,
    now: float | None = None,
    dry_run: bool = True,
    log_path: str | None = None,
) -> ObligationDecision:
    """One obligation, all the way through: meter, price, decide, maybe pay.

    ``dry_run`` defaults to TRUE, matching ``ops_actions``: the operator's
    default behaviour is to say what it would do. A caller that wants money to
    move has to say so, and the audit row exists either way.

    ``policy`` is a ``PolicyClient`` or anything with ``budget(category)`` and
    ``spend(category, to, amount, record)``. Injected rather than constructed so
    the whole path is testable without a chain — and so a business's own wallet
    can be passed in, which is the point of one wallet per business.

    The budget is read from the CONTRACT, not from a local tally. A local tally
    is a second opinion about the only thing that is authoritative, and the two
    drift the moment anything else spends from the same wallet.
    """
    from .par import par_from_quotes, quotes_from_catalog, quotes_from_receipts

    metered = meter_quantity(receipts, ob.vendor, ob.resource, since)

    quotes = quotes_from_catalog(catalog, ob.resource) + quotes_from_receipts(
        receipts, ob.resource
    )
    par = par_from_quotes(ob.resource, quotes, exclude_seller=ob.vendor)

    remaining = per_tx = None
    if policy is not None:
        budget = policy.budget(ob.category)
        if budget is None:
            # No budget on chain means no authority, and that is not the same as
            # a budget of zero: zero would read as "this category is exhausted
            # this period", which a human would wait out rather than fix.
            d = ObligationDecision(
                at=now if now is not None else time.time(),
                obligation_id=ob.obligation_id,
                vendor=ob.vendor,
                category=ob.category,
                billed_usdc=ob.billed_usdc,
                business=ob.business,
                resource=ob.resource,
                intent=ESCALATE,
                rule=f"no budget on chain for {ob.category}, so the agent has no authority here",
                escalated=True,
                metered_quantity=metered,
                vendor_quantity=ob.vendor_quantity,
            )
            log_decision(d, log_path)
            return d
        remaining = budget["remaining_usdc"]
        per_tx = budget["per_tx_limit_usdc"]

    d = decide(
        ob,
        par=par,
        metered_quantity=metered,
        settled_refs=settled_refs,
        remaining_usdc=remaining,
        per_tx_limit_usdc=per_tx,
        now=now,
    )

    if d.intent == PAY and policy is not None:
        if dry_run:
            d.notes.append("dry run: cleared policy, no payment sent")
        else:
            # The record is hashed into the payment, so the commitment to the
            # reasoning is made in the same transaction that moves the money.
            d.tx = policy.spend(ob.category, ob.vendor, ob.billed_usdc, d.as_record())
            d.paid_usdc = ob.billed_usdc

    log_decision(d, log_path)
    return d
