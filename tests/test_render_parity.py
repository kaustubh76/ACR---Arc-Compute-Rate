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
    # --- the thirty-one fields this gate could not see ---------------------
    # The fixture's rows were hand-written, so a field the dataclass gained
    # emitted no leaf and the gate reported clean on 56% of the record. They
    # start from `asdict` now. Of the twenty-seven names it then named, fourteen
    # are rendered on the decision row; these fifteen entries cover the thirteen
    # that belong on the record and not on the page, plus the two the gate let
    # through on its own narrow `parent.leaf` rule — `liq.held_usdc` in the Cash
    # section satisfied `recent[].held_usdc`, and a spurious pass is worse than
    # a written exemption because nobody can see it. Each line is a claim
    # somebody can argue with.
    #
    # THE FOUR THRESHOLDS. On the record because a reviewer replaying a decision
    # cannot recover an environment variable from the repo; off the page because
    # the rule sentence already quotes the breach in words, and a column of
    # unchanging constants is the kind of clutter that gets a surface ignored.
    "recent[].meter_tolerance": "the rule sentence names the breach; the constant is for replay",
    "recent[].material_bp": "same — on the record so a reviewer can replay, not so a reader can scan",
    "recent[].pay_window_s": "the rule says 'not due for N days'; the window itself is for replay",
    "recent[].unbenchmarked_max_usdc": "the rule names the limit when it fires; otherwise it is noise",
    "escalations[].meter_tolerance": "shown nowhere by design; see the recent[] entry",
    "escalations[].material_bp": "shown nowhere by design; see the recent[] entry",
    "escalations[].pay_window_s": "shown nowhere by design; see the recent[] entry",
    "escalations[].unbenchmarked_max_usdc": "shown nowhere by design; see the recent[] entry",
    # THE METERING WINDOW. It is what makes the obligation id trustworthy twice
    # (`operator.py` explains why at length), which is a property of the record
    # rather than a figure an owner reads.
    "recent[].period_start": "the window that makes the id unique per period, not a figure to read",
    "recent[].period_end": "same: derived from the data, and load-bearing for the duplicate check",
    "escalations[].period_start": "see the recent[] entry",
    "escalations[].period_end": "see the recent[] entry",
    # THE AGREEMENT'S IDENTITY. The VERDICT is now a chip on the row, which is
    # the part that changes what a reader concludes; the id and the hash are how
    # a reviewer finds the agreement in the register and proves it unedited.
    "recent[].commitment_id": "the verdict is on the row; the id is how a reviewer finds the agreement",
    "recent[].commitment_hash": "proves the agreement was not edited after the fact — a replay tool's job",
    "escalations[].commitment_id": "see the recent[] entry",
    "escalations[].commitment_hash": "see the recent[] entry",
    # THE SCREEN'S BOOLEANS. `screen_risk`, `screen_backend` and `screen_reason`
    # are all on the row; `required` and `screened` are the same facts as flags,
    # and the 'no screen' chip already says when nothing answered.
    "recent[].screen_required": "the 'no screen' chip says it, and two fields for one fact drift",
    "recent[].screen_screened": "implied by the verdict being present at all",
    "escalations[].screen_required": "see the recent[] entry",
    "escalations[].screen_screened": "see the recent[] entry",
    # THE CASH PICTURE, PER ROW. Identical on every decision in a pass, because
    # the keeper reads the balance once and injects one picture into all of
    # them. The statement renders it ONCE, in its own section at the top; down
    # the column it would be the same three numbers repeated per row.
    "recent[].held_usdc": "one picture per pass; the Cash section renders it once, above",
    "recent[].due_usdc": "one picture per pass; the Cash section renders it once, above",
    "recent[].liquidity_horizon_s": "rendered once as the Cash column header, in days",
    "escalations[].held_usdc": "see the recent[] entry",
    "escalations[].due_usdc": "see the recent[] entry",
    "escalations[].liquidity_horizon_s": "see the recent[] entry",
    # AND THE LAST TWO.
    "recent[].kind": (
        "x402 · invoice · milestone · subscription. An internal taxonomy for "
        "which feeder built the obligation; the resource and the vendor are "
        "what an owner recognises"
    ),
    "recent[].par_denomination": "`unit` or `whole`; the row renders the unit itself, which is the reader's question",
    "escalations[].kind": "see the recent[] entry",
    "escalations[].par_denomination": "see the recent[] entry",
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
    # RFB 5's counts live on /traction, the page that asks "how much is this
    # really doing". An owner's statement already shows the screen verdict on
    # every decision row, which is the per-decision form of the same fact.
    "spend.addresses_screened": "reported on /traction; this page shows the screen per decision",
    "spend.alerts_raised": "reported on /traction, beside the count that resolved them",
    "spend.alerts_resolved": "reported on /traction, as N of raised rather than a rate",
    "per_business[].addresses_screened": (
        "the aggregate asks the useful question — how many counterparties this "
        "agent put to a screen at all; the per-business table already carries "
        "`risk_events_caught`, which is the row-level fact that changes a decision"
    ),
    "per_business[].alerts_raised": "aggregated on /traction; the row shows what was caught",
    "per_business[].alerts_resolved": "aggregated on /traction; the row shows what was caught",
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
    # The only pair of the eight that is genuinely aggregate-only. Every
    # obligation this operator builds carries no due date, because nothing in
    # the real inputs supplies one, so per business this is 0 of 0 on every row
    # — a column of "none yet" teaching a reader nothing. The aggregate says it
    # once, where it belongs, and `autonomy()` refuses to report a rate over an
    # empty denominator either way.
    "per_business[].settled_on_time": "0 of 0 on every row; the aggregate says it once",
    "per_business[].settled_with_a_due_date": "the denominator for the line above, reported once",
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
    from dataclasses import asdict

    from index_api import businesses as biz
    from index_api import statement as st_mod
    from index_api.operator import ObligationDecision
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

    def row(**over) -> dict:
        """A decision row carrying EVERY field the operator records.

        HAND-WRITTEN DICTS ARE HOW THIS FIXTURE FELL 31 FIELDS BEHIND. A row
        that omits a field emits no leaf, so the gate reported clean on 58% of
        `ObligationDecision` — including the cash picture, the agreement
        verdict and every threshold the decision was judged against. Starting
        from `asdict` (which is what `operator.py:535` actually writes to the
        log) means a new field on the dataclass arrives here by itself, and the
        gate asks about it on the next run instead of never.
        """
        return {
            **asdict(ObligationDecision(
                at=0.0, obligation_id="", vendor="", category="",
                billed_usdc=0.0, intent="", rule="",
            )),
            **over,
        }

    rows = [
        row(**{  # a real payment, with every optional field populated
            "at": 1_790_900_000, "obligation_id": "paid-1", "vendor": "0x" + "bb" * 20,
            "category": "infra", "billed_usdc": 2.5, "intent": "pay", "rule": "at par",
            "business": "parity", "resource": "/compute/x", "metered_quantity": 5.0,
            "vendor_quantity": 5.0, "discrepancy": 0.0, "par_usdc": 0.5,
            "best_usdc": 0.48, "over_par_bp": 400.0, "saving_usdc": 0.1,
            "reroute_to": "", "escalated": False, "paid_usdc": 2.5,
            "tx": "0x" + "ee" * 32, "notes": ["a note"],
            "screen_risk": "clear", "screen_matched": [], "screen_backend": "yente",
        }),
        row(**{  # an escalation, so the queue is populated
            "at": 1_790_900_100, "obligation_id": "esc-1", "vendor": "0x" + "dd" * 20,
            "category": "infra", "billed_usdc": 150.0, "intent": "escalate",
            "rule": "over the per-payment limit", "business": "parity",
            "resource": "/compute/y", "metered_quantity": 1.0, "vendor_quantity": 1.0,
            "discrepancy": 0.0, "par_usdc": 1.0, "best_usdc": 0.9,
            "over_par_bp": 10.0, "saving_usdc": 0.0, "reroute_to": "",
            "escalated": True, "paid_usdc": 0.0, "tx": None, "notes": [],
            "screen_risk": "flagged", "screen_matched": ["us_ofac_sdn"],
            "screen_backend": "yente",
            # DATED, so `liquidity.due_usdc` is a real figure here rather than
            # the all-undated shape. In the past on purpose: `assess` counts an
            # overdue bill IN ("the most due thing there is") and that branch
            # is the one a horizon looking only forward would drop.
            "due_at": 1_791_000_000, "invoice_ref": "VENDOR-1001",
            "held_usdc": None, "due_usdc": 150.0, "liquidity_horizon_s": 2_592_000.0,
            "recommended_intent": "hold",
        }),
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


def _parent(path: str) -> str:
    """The key one level above a leaf, with list markers dropped."""
    parts = _norm(path).split(".")
    return parts[-2] if len(parts) > 1 else ""


def _rendered(leaf: str, src: str, rivals: set[str]) -> bool:
    """Is THIS field rendered — not merely a field with the same name?

    A BARE NAME SEARCH CANNOT TELL TWO FIELDS APART, and this payload emits the
    same eight names twice: once per business in `per_business[]` and once for
    the whole set in `work.autonomy`. The aggregate is rendered, the per-business
    figures were not, and the gate passed all eight on the strength of the
    aggregate — eight fields emitted and rendered nowhere, invisible to the exact
    check that exists to find them.

    So: when a leaf name is unambiguous, a bare match still proves it, because
    there is nothing else it could be. When another path emits the same name,
    the match has to be `something.leaf` where `something` is NOT the rival's
    parent. `r.settled_by_agent` counts; `autonomy.settled_by_agent` does not.

    Deliberately narrow. Tightening every leaf would fail fields that are read by
    destructuring or passed as a prop, and a gate that cries wolf gets exemptions
    written for it until it means nothing.
    """
    if not rivals:
        return bool(re.search(r"\b" + re.escape(leaf) + r"\b", src))
    pattern = r"([A-Za-z_$][\w$]*)\s*\.\s*" + re.escape(leaf) + r"\b"
    return any(m.group(1) not in rivals for m in re.finditer(pattern, src))


def test_every_emitted_field_is_rendered_or_exempt(payloads):
    unlisted: list[str] = []
    for name, payload in payloads.items():
        src = _source(name)
        paths = sorted(_leaves(payload))
        by_leaf: dict[str, set[str]] = {}
        for q in paths:
            by_leaf.setdefault(q.split(".")[-1].replace("[]", ""), set()).add(_parent(q))
        for path in paths:
            leaf = path.split(".")[-1].replace("[]", "")
            if not leaf or _exempt(path):
                continue
            rivals = by_leaf.get(leaf, set()) - {_parent(path)}
            if not _rendered(leaf, src, rivals):
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


def test_the_fixture_rows_carry_every_field_the_operator_records(payloads):
    """The blindness this gate shipped with, pinned so it cannot come back.

    Thirty-one of the fifty-five fields `operator.py:535` writes to the log were
    absent from the hand-written fixture rows, and A FIELD THAT IS ABSENT EMITS
    NO LEAF — so the check designed to catch "emitted and rendered nowhere"
    reported clean on the cash picture, the agreement verdict, who acted, and
    every threshold the decision was judged against. 56% of the record was
    outside its reach, and every one of those thirty-one is inside the
    fifty-three `as_record` hashes into the wallet.

    The rows start from `asdict` now, which is what `operator.py` writes to the
    log. This is the check that says so, and the one that fails the day somebody
    writes a literal dict back in.
    """
    from dataclasses import asdict

    from index_api.operator import ObligationDecision

    recorded = set(asdict(ObligationDecision(
        at=0.0, obligation_id="", vendor="", category="",
        billed_usdc=0.0, intent="", rule="",
    )))
    for name in ("recent", "escalations"):
        rows = payloads["statement"][name]
        assert rows, f"the fixture has no {name} rows, so it audits nothing"
        missing = sorted(recorded - set(rows[0]))
        assert missing == [], (
            f"{name}[] is missing {len(missing)} fields the operator records, so "
            "this gate cannot see them:\n  " + "\n  ".join(missing)
        )


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


# --- the gate's own blind spot ---------------------------------------------


def test_a_bare_name_cannot_prove_which_field_is_rendered():
    """The hole this gate shipped with, pinned so it cannot come back.

    `per_business[].settled_by_agent` and `work.autonomy.settled_by_agent` are
    two different facts with one name. The gate searched for the bare word, so
    the aggregate — which IS rendered — satisfied all eight per-business leaves,
    and eight figures were emitted and rendered nowhere while the check designed
    to find exactly that reported clean.
    """
    aggregate_only = "<td>{fmtInt(t.work.autonomy.settled_by_agent)}</td>"
    assert not _rendered("settled_by_agent", aggregate_only, {"autonomy"}), (
        "an aggregate read must not vouch for a per-row field of the same name"
    )

    with_the_row = aggregate_only + "<td>{fmtInt(r.settled_by_agent)}</td>"
    assert _rendered("settled_by_agent", with_the_row, {"autonomy"})


def test_an_unambiguous_name_still_passes_on_a_bare_match():
    """Tightening every leaf would fail fields read by destructuring or passed
    as a prop, and a gate that cries wolf gets exemptions written for it until
    it means nothing. The strict rule applies only where a name is emitted
    twice."""
    assert _rendered("clean", "if (!a.clean) return null;", set())
    assert _rendered("note", "const { note } = payload;", set())
    assert not _rendered("nowhere", "nothing mentions it", set())


def test_rivals_are_computed_from_the_payload_not_hand_listed():
    """The ambiguity has to come from the data, or the next collision is missed.

    `_parent` is what makes a rival a rival: two paths share a leaf name and
    differ in the key above it.
    """
    assert _parent("work.autonomy.settled_by_agent") == "autonomy"
    assert _parent("per_business[].settled_by_agent") == "per_business"
    assert _parent("clean") == ""
