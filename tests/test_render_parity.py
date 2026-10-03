"""Every field a payload emits is rendered somewhere, or exempt with a reason.

THE GUARD THIS REPO DID NOT HAVE. `/spend` shipped rendering a green "paid"
chip on six decisions whose `paid_usdc` was 0.0 — dry runs that moved nothing —
while the beancount export of the same records correctly said "cleared policy,
not sent". And `metered_quantity`, the independent count this whole build is
named after, was present on every decision and rendered nowhere. Both passed
typecheck, lint, build, 210 terminal tests and the full claims audit, because
nothing anywhere compared what the API emits against what the page reads.

So this does, in the shape `coverage.test.ts` already uses for edition markers:
a two-sided ledger. A field in neither `RENDERED` (found in the view source)
nor `EXEMPT` (with a reason) fails, and an `EXEMPT` entry for a field that no
longer exists fails too — a ledger that only ever grows is a list of excuses.

Python reads the TypeScript because only Python can build the payloads. The repo
already crosses that line in both directions: `test_endpoint_register_parity.py`
reads `endpoints.ts`, and `apps/terminal/lib/chain.test.ts` reads `ops.py`.

THE PAYLOADS ARE SEEDED TO BE COMPLETE. An audit against whatever the live
registry happens to hold would never check `budgets` or `market_context`,
because the one real business has no wallet and no indexed history — which is
exactly how those two blocks reached production never having been exercised.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TERMINAL = ROOT / "apps" / "terminal"

#: payload name → the view files allowed to satisfy it
VIEWS: dict[str, tuple[str, ...]] = {
    "statement": (
        "app/spend/view.tsx",
        "components/spend/EscalationActions.tsx",
    ),
    # The SAME views, audited against a statement whose market context failed.
    # `market_context` is a union of three shapes and only the happy one was
    # ever seeded, so `reason` — the field that tells SLOW from "no tape for
    # this payer" — was never audited at all, and the page rendered one fixed
    # sentence for every cause. A gate that only ever sees the good payload
    # audits the good payload.
    "statement (market context unavailable)": (
        "app/spend/view.tsx",
        "components/spend/EscalationActions.tsx",
    ),
    "traction": ("app/traction/view.tsx",),
    "audit": ("app/spend/view.tsx",),
}

#: field path → why it is deliberately not rendered. Every entry is a claim
#: somebody can argue with, which is the point of writing it down.
EXEMPT: dict[str, str] = {
    # --- statement ---
    "as_of": "the page renders the envelope's fetchedAt age instead, which is when the READER got it",
    "business.name": "`label` carries it, and consent is enforced server-side by omitting the key",
    "business.consented": "folded into `label`: an unconsented business renders as its pseudonym",
    "business.categories": "the budget rows are keyed by category, so the list is redundant",
    "business.onboarded_at": "not a fact an owner reading their own statement needs",
    "business.treasury": "shown on /traction, where comparing businesses is the point",
    "business.slug": "passed to the settle control as an identifier, never displayed",
    "business.tier": "how we met them is a traction fact, not a spending one",
    "market_context.note": "the view states the bp-only caveat in both editions beside the figure",
    "market_context.spent_usdc": "the summary's own paid/priced figures are the honest ones",
    "market_context.benchmarked": "purchases carries the same signal for a reader",
    "period_days": (
        "rendered as the section label on the statement; on the audit the window "
        "is the whole record rather than a figure a reader picks"
    ),
    "recent[].at": "the rows are already newest-first; a timestamp per row is noise",
    "recent[].obligation_id": "the React key and the settle control's parameter, not display",
    "recent[].business": "every row on this page belongs to the business in the heading",
    "recent[].category": "the budget block is where a category means something",
    "recent[].escalated": "`intent` already says it, and two fields for one fact drift",
    "recent[].over_par_bp": "the rule sentence quotes the gap that drove the decision",
    "recent[].saving_usdc": "the rule sentence quotes it, in the comparison it was measured in",
    "recent[].paid_usdc": "read by `outcome()` to tell a payment from a dry run",
    "escalations[].at": "part of the React key",
    "escalations[].obligation_id": "the settle control's parameter",
    "escalations[].business": "every escalation here belongs to this business",
    "escalations[].billed_usdc": "rendered in the block heading",
    "escalations[].vendor": "rendered in the block heading",
    "escalations[].escalated": "every row in this queue is escalated by definition",
    "escalations[].category": "not what a person deciding this needs first",
    "escalations[].intent": "every row in this queue is an escalation",
    "escalations[].rule": "rendered as the block's standfirst",
    "escalations[].notes": "the rule carries the reason a person acts on",
    "escalations[].resource": "the vendor and the amount are the decision",
    "escalations[].paid_usdc": "nothing in this queue has been paid",
    "escalations[].metered_quantity": "shown in the full decision table below",
    "escalations[].vendor_quantity": "shown in the full decision table below",
    "escalations[].discrepancy": "shown in the full decision table below",
    "escalations[].screen_risk": "shown in the full decision table below",
    "escalations[].screen_matched": "shown in the full decision table below",
    "escalations[].par_usdc": "shown in the full decision table below",
    "escalations[].best_usdc": "shown in the full decision table below",
    "escalations[].reroute_to": "an escalation has not been rerouted",
    "escalations[].saving_usdc": "nothing is recoverable until somebody decides; the table below carries it",
    "escalations[].over_par_bp": "the rule quotes the gap that stopped it; the table below carries the figure",
    "escalations[].tx": "nothing in this queue has a transaction yet",
    "budgets[].period_start": "a period's start is not what an owner checks; `left` is",
    "budgets[].period_length": "same: the figure that matters is what is left",
    "budgets[].per_tx_limit_usdc": "surfaced as the escalation rule when it fires",
    "spend.by_intent": "the summary counts decided and escalated; /traction breaks out intents",
    # The RFB figures are computed in `summarise` because /traction needs them
    # per business, and reported on /traction because that is the page asking
    # "how much is this really doing". Repeating them on an owner's statement,
    # which already carries `decided` and `escalated`, would be two numbers for
    # one fact in two places that drift.
    "spend.settled_by_agent": "reported on /traction, beside its own denominator",
    "spend.settled_by_owner": "reported on /traction, beside its own denominator",
    "spend.settled_on_time": "reported on /traction, against obligations that have a due date",
    "spend.settled_with_a_due_date": "the denominator for the line above, on /traction",
    "spend.owner_resolutions": "the denominator for agreement, on /traction",
    "spend.owner_agreed": "reported on /traction, as N of resolutions rather than a rate",
    "spend.risk_events_caught": (
        "reported on /traction; this page surfaces the screen per decision, "
        "where a reader can see which counterparty it was"
    ),
    "spend.paid_unscreened": (
        "reported on /traction; per decision this page already shows the "
        "'no record' and screen chips on the row itself"
    ),
    "spend.unmetered": "surfaced per decision as the 'no record' chip",
    # --- traction ---
    # (`note` is rendered verbatim by the view, so it is not exempt.)
    "businesses.mainnet": "`by_chain` reports each chain's own figures",
    "businesses.testnet": "`by_chain` reports each chain's own figures",
    "per_business[].slug": "the React key, and what both of this row's links are built from",
    "per_business[].statement": (
        "the PRESS's own path. Correct there, wrong here: it is relative, so on "
        "the terminal origin it resolved against the terminal and 404ed. The "
        "view links to /spend?business={slug} instead"
    ),
    "per_business[].ledger": (
        "same — the view links to its own proxy, /api/operator/ledger?business={slug}, "
        "which serves the beancount file as a download"
    ),
    "per_business[].consented": "folded into `label`",
    "per_business[].decided": "the work block reports it across all businesses",
    "per_business[].escalated": "the work block reports it across all businesses",
    "per_business[].unmetered": "surfaced per decision on /spend",
    "work.decisions": "rendered as the section label",
    # --- audit ---
    # (`clean`, `checks[]` and `findings[]` are all rendered; `as_of` is covered
    #  by the entry at the top of this ledger.)
    "checks[].question": (
        "asked in the section's own standfirst, in both editions, rather than "
        "six times down a column nobody would read twice"
    ),
    "note": "the same caveat is the standfirst, where a reader meets it first",
    "decisions": (
        "the count of decisions audited. The statement above it already reports "
        "the period's decision count, and two numbers for one fact drift"
    ),
    "business": "the page is already a single business's, named in its heading",
    "findings[].obligation_id": (
        "part of the React key, and empty by design on a period-level finding "
        "like a compensating pair, where no single row is the error"
    ),
}


def _leaves(obj, prefix: str = "", out: set[str] | None = None) -> set[str]:
    out = out if out is not None else set()
    if isinstance(obj, dict):
        if not obj:
            out.add(prefix)
        for k, v in obj.items():
            out |= _leaves(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(obj, list):
        if obj:
            out |= _leaves(obj[0], prefix + "[]")
        else:
            # An EMPTY list is still a field, and the first version of this
            # walker dropped it — so `notes: []` and `screen_matched: []` were
            # never audited at all. A field that exists and gets skipped is
            # precisely what this gate is here to prevent.
            out.add(prefix)
    else:
        out.add(prefix)
    return out


def _norm(path: str) -> str:
    """A field path with the list markers dropped.

    `_leaves` names a populated list `foo[]` and an empty one `foo`, so keying
    the ledger on the raw path would make an exemption depend on whether the
    sample data happened to put anything in the list. Normalising means one
    entry covers both.
    """
    return path.replace("[]", "")


def _exempt(path: str) -> bool:
    """Is this field, or a block containing it, exempt?

    A prefix match on purpose: `spend.by_intent` exempts every count under it,
    because "this whole block is reported elsewhere" is one claim and should be
    written once rather than five times.
    """
    n = _norm(path)
    return any(n == k or n.startswith(k + ".") for k in (_norm(e) for e in EXEMPT))


def _source(name: str) -> str:
    return "\n".join((TERMINAL / f).read_text(encoding="utf-8") for f in VIEWS[name])


def _payloads(tmp_path, monkeypatch) -> dict[str, dict]:
    """Payloads with EVERY optional block populated.

    Seeded rather than read from the live registry, because the one real
    business has no wallet and no indexed history — so an audit against it would
    skip `budgets` and `market_context` entirely, which is how both of those
    reached production unexercised.
    """
    from index_api import businesses as biz
    from index_api import statement as st_mod
    from index_api.statement import build_statement
    from index_api.traction import build_traction

    reg = tmp_path / "businesses.json"
    reg.write_text(json.dumps({"businesses": [{
        "slug": "parity", "treasury": "0x" + "aa" * 20, "name": "Parity Co",
        "consented": True, "tier": "network", "chain": "testnet",
        "policy_wallet": "0x" + "cc" * 20, "categories": ["infra"],
        "onboarded_at": 1_790_000_000,
    }]}))
    monkeypatch.setattr(biz, "REGISTRY_PATH", reg)

    rows = [
        {  # a real payment, with every optional field populated
            "at": 1_790_900_000, "obligation_id": "paid-1", "vendor": "0x" + "bb" * 20,
            "category": "infra", "billed_usdc": 2.5, "intent": "pay", "rule": "at par",
            "business": "parity", "resource": "/compute/x", "metered_quantity": 5.0,
            "vendor_quantity": 5.0, "discrepancy": 0.0, "par_usdc": 0.5,
            "best_usdc": 0.48, "over_par_bp": 400.0, "saving_usdc": 0.1,
            "reroute_to": "", "escalated": False, "paid_usdc": 2.5,
            "tx": "0x" + "ee" * 32, "notes": ["a note"],
            "screen_risk": "clear", "screen_matched": [], "screen_backend": "yente",
        },
        {  # an escalation, so the queue is populated
            "at": 1_790_900_100, "obligation_id": "esc-1", "vendor": "0x" + "dd" * 20,
            "category": "infra", "billed_usdc": 150.0, "intent": "escalate",
            "rule": "over the per-payment limit", "business": "parity",
            "resource": "/compute/y", "metered_quantity": 1.0, "vendor_quantity": 1.0,
            "discrepancy": 0.0, "par_usdc": 1.0, "best_usdc": 0.9,
            "over_par_bp": 10.0, "saving_usdc": 0.0, "reroute_to": "",
            "escalated": True, "paid_usdc": 0.0, "tx": None, "notes": [],
            "screen_risk": "flagged", "screen_matched": ["us_ofac_sdn"],
            "screen_backend": "yente",
        },
    ]
    log = tmp_path / "live.jsonl"
    log.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    monkeypatch.setattr(st_mod, "LOG_PATH", str(log))
    monkeypatch.setattr(st_mod, "ARCHIVE_PATH", tmp_path / "absent.jsonl")

    class _Pol:
        """A wallet that answers for one category and refuses the other.

        The refusing branch is seeded on purpose: `_budgets` now explains WHY a
        budget is unconfigured, and a payload that only ever contains the happy
        shape audits the happy shape. That is the hole that let
        `market_context.reason` ship unrendered.
        """

        def wallet_status(self):
            return "ok"

        def budget(self, category):
            return {
                "category": category, "cap_usdc": 1000.0, "spent_usdc": 2.5,
                "remaining_usdc": 997.5, "per_tx_limit_usdc": 100.0,
                "period_start": 1_790_000_000, "period_length": 2_592_000,
                "configured": True,
            }

    statement = build_statement(
        "parity", days=90, policy_for=lambda b: _Pol(),
        tca_fn=lambda payer, days=7: {
            "available": True, "purchases": 12, "benchmarked": 10,
            "spent_usdc": 2.5, "vw_slippage_bp": 130.0, "overpaid_usdc": 999.0,
        },
    )
    # The same statement with the market context refused, which is the shape
    # production serves whenever the subgraph is slow or silent. `_market_card`
    # answers `{"available": False, "reason": ...}` and `build_statement` passes
    # the reason through, so this exercises the branch rather than asserting it.
    degraded = build_statement(
        "parity", days=90, policy_for=lambda b: _Pol(),
        tca_fn=lambda payer, days=7: {"available": False, "reason": "SLOW"},
    )
    # The six-error audit, with a finding planted so `findings[]` is a populated
    # list rather than an empty one. An empty list is a different leaf set, and
    # auditing only the empty shape is how `notes: []` went unchecked here once.
    from index_api.ledger_audit import audit as ledger_audit

    tape = [{
        "payer": "0x" + "aa" * 20, "seller": "0x" + "bb" * 20,
        "resource": "https://press.example/compute/x", "amount_usdc": 1.0,
        "quantity": 10.0,
    }]
    audited = ledger_audit(
        [{
            "at": 1_790_900_000.0, "obligation_id": "paid-1", "vendor": "0x" + "cc" * 20,
            "category": "not-declared", "billed_usdc": 1.0, "paid_usdc": 9.0,
            "intent": "pay", "rule": "at par", "resource": "/compute/x",
            "discrepancy": None,
        }],
        tape,
        treasury="0x" + "aa" * 20,
        slug="parity",
        categories=("infra",),
    )
    audited["business"] = "parity"
    audited["period_days"] = 90

    return {
        "statement": statement,
        "statement (market context unavailable)": degraded,
        "traction": build_traction(),
        "audit": audited,
    }


@pytest.fixture
def payloads(tmp_path, monkeypatch):
    return _payloads(tmp_path, monkeypatch)


def test_every_emitted_field_is_rendered_or_exempt(payloads):
    unlisted: list[str] = []
    for name, payload in payloads.items():
        src = _source(name)
        for path in sorted(_leaves(payload)):
            leaf = path.split(".")[-1].replace("[]", "")
            if not leaf or _exempt(path):
                continue
            if not re.search(r"\b" + re.escape(leaf) + r"\b", src):
                unlisted.append(f"{name}: {path}")
    assert unlisted == [], (
        "these fields are emitted and rendered nowhere. Render them, or add an "
        "EXEMPT entry saying why not:\n  " + "\n  ".join(unlisted)
    )


def test_the_exempt_ledger_has_no_entries_for_fields_that_no_longer_exist(payloads):
    """A ledger that only ever grows is a list of excuses."""
    live = set()
    for payload in payloads.values():
        live |= {_norm(p) for p in _leaves(payload)}
    # A block exemption is live if anything beneath it is.
    gone = sorted(
        k for k in EXEMPT
        if not any(f == _norm(k) or f.startswith(_norm(k) + ".") for f in live)
    )
    assert gone == [], "EXEMPT entries with no such field:\n  " + "\n  ".join(gone)


def test_every_exemption_gives_a_reason():
    blank = sorted(k for k, v in EXEMPT.items() if not v.strip())
    assert blank == [], f"exemptions with no reason: {blank}"


def test_a_dry_run_is_not_rendered_as_a_payment(payloads):
    """The bug that prompted this file. `/spend` must distinguish a `pay` that
    sent nothing from one that did, because the beancount export of the same
    record already does and two surfaces must not disagree about one fact."""
    src = _source("statement")
    assert "cleared policy, not sent" in src, (
        "the view does not carry the exporter's wording for a dry run"
    )
    assert "paid_usdc" in src, "the view never reads paid_usdc, so it cannot tell them apart"


def test_the_meter_and_the_screen_are_both_on_the_page(payloads):
    """Prior Art #06 is the independent meter and two RFBs ask for screening in
    the path. Both were emitted and invisible."""
    src = _source("statement")
    for field in ("metered_quantity", "vendor_quantity", "screen_risk"):
        assert field in src, f"{field} is emitted and the page never reads it"
