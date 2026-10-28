"""`rule_id` — the gate that fired, as something countable.

WHY THIS EXISTS. "Ten ordered refusals before any money moves" invites exactly
one question — WHICH ONE FIRES MOST — and until now the record could not answer
it. `rule` is a sentence carrying the amounts and the thresholds, which is what
makes it useful to a reviewer and useless as a key: "250 bp above the cheapest
offer: 0.04 is available" and "310 bp above the cheapest offer: 0.05 is
available" are one gate and two strings. A histogram over `rule` reports one of
everything.

Two halves, and both matter. The STATIC half holds `RULE_IDS` and the source in
step, so a new gate cannot ship unnamed and a name cannot quietly change — both
would corrupt a count kept over time, and silently, because the rows either side
would look fine. The DYNAMIC half drives `decide()` and checks the id against
the gate that actually fired, because a constant that agrees with a grep still
proves nothing about which branch set it.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest
from index_api.operator import (
    ESCALATE,
    HOLD,
    PAY,
    REFUSE,
    REROUTE,
    RULE_IDS,
    Obligation,
    decide,
)
from index_api.par import Quote, par_from_quotes

SOURCE = Path(__file__).resolve().parents[1] / "index_api" / "operator.py"

VENDOR = "0x" + "aa" * 20
OTHER = "0x" + "bb" * 20
THIRD = "0x" + "cc" * 20
ZERO = "0x" + "00" * 20
RES = "https://acr.example/compute/inference"
NOW = 1_790_000_000.0


def _par(*prices_by_seller, exclude=VENDOR):
    quotes = [
        Quote(seller=s, price_usdc=p, source="catalog", resource=RES)
        for s, p in prices_by_seller
    ]
    return par_from_quotes(RES, quotes, exclude_seller=exclude)


def _ob(**kw) -> Obligation:
    base = dict(
        obligation_id="ob-1", vendor=VENDOR, billed_usdc=1.0,
        category="infra", resource=RES,
    )
    base.update(kw)
    return Obligation(**base)


AT_PAR = ((OTHER, 1.0), (THIRD, 1.0))
CHEAPER = ((OTHER, 0.5), (THIRD, 0.6))


# --- the static half ----------------------------------------------------------


def _emitted_ids() -> set[str]:
    """Every literal id the module assigns to `rule_id`, read from the AST.

    PARSED, NOT GREPPED, and both wrong versions are worth recording. A regex
    taking the first quoted string after `rule_id =` declared
    `pay_unbenchmarked` dead, because the clean path assigns with a ternary:

        d.rule_id = "pay_benchmarked" if verdict.get("benchmarked") else "pay_unbenchmarked"

    Widening it to every quoted string on the line then picked up
    `"benchmarked"` — the dict key from the condition — and called it an
    undeclared id. The assigned VALUE is a syntactic fact, so it is read
    syntactically: `ast` walks the right-hand side and nothing else.
    """
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    out: set[str] = set()

    def collect(node: ast.AST) -> None:
        """Only values that can actually BE the id.

        For a conditional, that is the two branches and never the test: the
        clean path's condition is `verdict.get("benchmarked")`, and a walk of
        the whole expression reported `"benchmarked"` as an undeclared id.
        """
        if isinstance(node, ast.IfExp):
            collect(node.body)
            collect(node.orelse)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.add(node.value)
        elif isinstance(node, ast.BoolOp):
            for v in node.values:
                collect(v)

    for node in ast.walk(tree):
        # `d.rule_id = ...` and `self.rule_id = ...`
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Attribute) and t.attr == "rule_id":
                    collect(node.value)
        # `rule_id="..."` passed to a constructor
        elif isinstance(node, ast.keyword) and node.arg == "rule_id":
            collect(node.value)
    return out


def test_every_id_the_code_emits_is_declared():
    stray = _emitted_ids() - set(RULE_IDS)
    assert stray == set(), (
        f"these ids are assigned in operator.py but missing from RULE_IDS: {sorted(stray)}. "
        "A count kept over time cannot include a category nobody declared."
    )


def test_every_declared_id_is_actually_emitted():
    """A name nothing can produce is a row in a report that is always zero, which
    reads as "this never happens" rather than "this was renamed"."""
    dead = set(RULE_IDS) - _emitted_ids()
    assert dead == set(), f"declared but never assigned: {sorted(dead)}"


def test_the_ids_are_a_closed_set_of_the_expected_size():
    """Pins the count so adding a gate is a deliberate edit to this file too."""
    assert len(RULE_IDS) == 22
    assert all(re.fullmatch(r"[a-z][a-z0-9_]*", i) for i in RULE_IDS)


# --- the dynamic half ---------------------------------------------------------

#: (expected id, obligation, kwargs, expected intent).
#:
#: The par is priced AT the bill wherever the gate under test sits below the
#: market rung — a bill sixty times par reroutes before it ever reaches the
#: budget, which is the ladder's order working and not a bug. Writing these the
#: careless way is how the first draft of this table "proved" that the per-tx
#: limit emitted `cheaper_elsewhere`.
CASES = [
    ("duplicate_reference", _ob(), {"par": _par(*AT_PAR), "settled_refs": {"ob-1"}}, REFUSE),
    ("no_payee", _ob(vendor=ZERO), {"par": _par(*AT_PAR)}, REFUSE),
    ("no_amount", _ob(billed_usdc=0.0), {"par": _par(*AT_PAR)}, REFUSE),
    ("unmetered", _ob(vendor_quantity=10.0), {"par": _par(*AT_PAR), "metered_quantity": None}, ESCALATE),
    ("meter_short", _ob(vendor_quantity=10.0), {"par": _par(*AT_PAR), "metered_quantity": 4.0}, ESCALATE),
    ("cheaper_elsewhere", _ob(), {"par": _par(*CHEAPER), "remaining_usdc": 100.0, "per_tx_limit_usdc": 50.0}, REROUTE),
    ("not_yet_due", _ob(due_at=NOW + 40 * 86_400), {"par": _par(*AT_PAR), "remaining_usdc": 100.0, "per_tx_limit_usdc": 50.0}, HOLD),
    ("over_per_tx_limit", _ob(billed_usdc=60.0), {"par": _par((OTHER, 60.0), (THIRD, 60.0)), "remaining_usdc": 1000.0, "per_tx_limit_usdc": 50.0}, ESCALATE),
    ("over_budget", _ob(billed_usdc=5.0), {"par": _par((OTHER, 5.0), (THIRD, 5.0)), "remaining_usdc": 2.0, "per_tx_limit_usdc": 50.0}, ESCALATE),
    ("pay_benchmarked", _ob(), {"par": _par(*AT_PAR), "remaining_usdc": 100.0, "per_tx_limit_usdc": 50.0}, PAY),
    ("pay_unbenchmarked", _ob(), {"par": None, "remaining_usdc": 100.0, "per_tx_limit_usdc": 50.0}, PAY),
]


@pytest.mark.parametrize(("want", "ob", "kw", "intent"), CASES, ids=[c[0] for c in CASES])
def test_the_gate_that_fired_is_the_gate_that_is_named(want, ob, kw, intent):
    d = decide(ob, now=NOW, **kw)
    assert d.intent == intent, f"{want}: expected {intent}, got {d.intent} ({d.rule})"
    assert d.rule_id == want, f"expected {want}, got {d.rule_id!r} ({d.rule})"
    assert d.rule_id in RULE_IDS


def test_every_decision_that_states_a_rule_also_names_it():
    """The invariant that makes the histogram total match the row count."""
    for want, ob, kw, _ in CASES:
        d = decide(ob, now=NOW, **kw)
        assert d.rule, f"{want} produced no rule sentence"
        assert d.rule_id, f"{want} stated a rule with no id, so it cannot be counted"


def test_the_id_follows_the_ORDER_not_the_severity():
    """A duplicate that is also overpriced and over budget is a duplicate.

    The ordering has its own suite; this asserts the ID agrees with it, because
    an id assigned at the wrong point in the ladder would misattribute every
    refusal it touched while every intent stayed correct.
    """
    d = decide(
        _ob(billed_usdc=9.0),
        par=_par(*CHEAPER),
        settled_refs={"ob-1"},
        remaining_usdc=1.0,
        per_tx_limit_usdc=0.5,
        now=NOW,
    )
    assert d.intent == REFUSE
    assert d.rule_id == "duplicate_reference"


def test_an_old_row_without_an_id_is_empty_rather_than_guessed():
    """`rule_id` cannot be recovered from the prose after the fact, and a
    best-effort backfill would put invented categories in a count."""
    import json

    archive = SOURCE.parent / "operator_decisions.jsonl"
    rows = [json.loads(x) for x in archive.read_text(encoding="utf-8").splitlines() if x.strip()]
    assert rows, "the archive is empty, so this proves nothing"
    assert all(not r.get("rule_id") for r in rows)
    assert all(r.get("rule") for r in rows), "every archived row still states its rule"
