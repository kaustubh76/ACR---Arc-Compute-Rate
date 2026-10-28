"""The tape against the chain, joined on the decision hash.

Every row here is built through `ObligationDecision` and hashed with the real
`decision_hash`, so the join key is produced the same way the production path
produces it. Nothing stubs the hash — a reconciler tested against a fake key
would agree with itself about anything.
"""
from __future__ import annotations

from dataclasses import asdict

from acr_oracle_client.policy import decision_hash
from acr_oracle_client.spend_ledger import Spend
from index_api.operator import ObligationDecision, hashable_record
from index_api.reconcile import reconcile, row_hash, scope_rows

CHAIN = 5042002
WALLET = "0xa67F188746f479A9d93D112BeeB7aadB90bE834b"
VENDOR = "0x" + "ab" * 20
ACTOR = "0x" + "cd" * 20


def _row(intent: str = "pay", *, billed: float = 0.01, tx: str = "", scoped: bool = True, **kw) -> dict:
    d = ObligationDecision(
        at=1_791_000_000.0,
        obligation_id=f"acr-fleet:{VENDOR[:10]}:{intent}-{billed}",
        vendor=VENDOR,
        category="machine-services",
        billed_usdc=billed,
        intent=intent,
        rule=f"{intent} because the test said so",
        business="acr-fleet",
        **kw,
    )
    if scoped:
        d.chain_id = CHAIN
        d.wallet = WALLET
    if tx:
        d.tx = tx
        d.paid_usdc = billed
    return asdict(d)


def _spend(row: dict | None = None, *, amount: float = 0.01, block: int = 100,
           owner: bool = False, dh: str | None = None) -> Spend:
    h = dh or (row_hash(row) if row else "0x" + "11" * 32)
    return Spend(
        block=block, tx="0x" + "ee" * 32, log_index=0,
        category="0x" + "0e" * 32, to=VENDOR, actor=ACTOR,
        amount_usdc=amount, decision_hash=h, owner_approved=owner,
        spent_in_period_usdc=amount, cap_usdc=5.0, period_start=1_791_000_000,
    )


# --- the join itself ----------------------------------------------------------


def test_a_paid_decision_present_on_chain_is_settled_and_clean():
    row = _row("pay", tx="0x" + "ff" * 32)
    r = reconcile([row], [_spend(row)], chain_id=CHAIN, wallet=WALLET)
    assert r.counts["settled"] == 1
    assert r.clean, r.counts
    assert r.alarms == []


def test_money_that_moved_with_no_decision_is_the_headline_alarm():
    """A `Spent` with nothing behind it. What a bypassed operator looks like."""
    r = reconcile([], [_spend(amount=0.25, block=7)], chain_id=CHAIN, wallet=WALLET)
    assert r.counts["unexplained"] == 1
    assert not r.clean
    f = r.alarms[0]
    assert f.kind == "unexplained" and f.amount_usdc == 0.25 and f.block == 7
    assert "no decision recorded" in f.detail


def test_a_refusal_whose_hash_is_on_chain_outranks_every_other_alarm():
    """The decision said no and the payment happened anyway."""
    refused = _row("refuse", billed=0.4)
    r = reconcile(
        [refused],
        [_spend(refused, amount=0.4), _spend(amount=0.01, block=9)],
        chain_id=CHAIN, wallet=WALLET,
    )
    assert r.counts["paid_against_decision"] == 1
    assert r.counts["unexplained"] == 1
    # Worst first: a payment against a refusal is worse than an unexplained one.
    assert [f.kind for f in r.alarms] == ["paid_against_decision", "unexplained"]
    assert "said 'refuse'" in r.alarms[0].detail


def test_a_recorded_transaction_the_chain_does_not_show_is_flagged():
    r = reconcile([_row("pay", tx="0x" + "ff" * 32)], [], chain_id=CHAIN, wallet=WALLET)
    assert r.counts["recorded_unseen"] == 1
    assert r.alarms[0].kind == "recorded_unseen"


def test_a_pay_that_was_never_sent_is_not_an_alarm():
    """Decided to pay, no tx, nothing on chain — a dry run, not a discrepancy."""
    r = reconcile([_row("pay")], [], chain_id=CHAIN, wallet=WALLET)
    assert r.counts["decided_unsent"] == 1
    assert r.clean


def test_a_refusal_absent_from_chain_is_the_system_working():
    r = reconcile([_row("refuse"), _row("hold"), _row("reroute")], [],
                  chain_id=CHAIN, wallet=WALLET)
    assert r.counts["consistent"] == 3
    assert r.clean


# --- the tamper proof ---------------------------------------------------------


def test_editing_one_character_of_a_row_breaks_its_match():
    """Why the hash is the join key and not the obligation id.

    The chain holds a commitment to the row's exact content. Change a digit of
    the amount after the fact and the row stops matching its own payment — so
    an edited record reads as `unexplained` plus `recorded_unseen`, not as a
    clean audit.
    """
    row = _row("pay", billed=0.01, tx="0x" + "ff" * 32)
    on_chain = _spend(row)
    assert reconcile([row], [on_chain], chain_id=CHAIN, wallet=WALLET).clean

    edited = dict(row)
    edited["billed_usdc"] = 0.02
    r = reconcile([edited], [on_chain], chain_id=CHAIN, wallet=WALLET)
    assert not r.clean
    assert r.counts["unexplained"] == 1
    assert r.counts["recorded_unseen"] == 1


def test_row_hash_matches_the_hash_the_payment_path_would_have_committed():
    """`row_hash` must agree with `as_record()`, or the join is meaningless."""
    d = ObligationDecision(
        at=1.0, obligation_id="o", vendor=VENDOR, category="infra",
        billed_usdc=1.0, intent="pay", rule="r", chain_id=CHAIN, wallet=WALLET,
    )
    committed = "0x" + decision_hash(d.as_record()).hex()
    d.tx = "0x" + "ab" * 32   # set AFTER the commitment, as production does
    d.paid_usdc = 1.0
    assert row_hash(asdict(d)) == committed
    assert hashable_record(asdict(d)).get("tx") is None


# --- refusing to judge what cannot be scoped ----------------------------------


def test_rows_naming_no_wallet_are_unscoped_not_alarms():
    """The 19 archived rows name neither chain nor wallet.

    Judging them would have manufactured six alarms out of a schema gap, so they
    are counted and excluded.
    """
    rows = [_row("pay", tx="0x" + "ff" * 32, scoped=False) for _ in range(3)]
    r = reconcile(rows, [], chain_id=CHAIN, wallet=WALLET)
    assert r.counts["unscoped"] == 3
    assert r.scoped_rows == 0 and r.unscoped_rows == 3
    assert r.clean, "an unscopeable row is not evidence of anything"
    assert "recorded_unseen" not in r.counts


def test_a_row_from_another_wallet_is_out_of_scope():
    other = _row("pay")
    other["wallet"] = "0x" + "99" * 20
    inside, outside = scope_rows([other], CHAIN, WALLET)
    assert inside == [] and len(outside) == 1


def test_a_row_from_another_chain_is_out_of_scope():
    other = _row("pay")
    other["chain_id"] = 5042
    inside, outside = scope_rows([other], CHAIN, WALLET)
    assert inside == [] and len(outside) == 1


# --- the chain picture, which needs no tape -----------------------------------


def test_the_chain_picture_stands_alone():
    """On a disk-less host a missing tape is the normal case, not the disaster."""
    spends = [
        _spend(amount=0.01, block=1, owner=False),
        _spend(amount=0.09, block=2, owner=True, dh="0x" + "22" * 32),
        _spend(amount=0.10, block=3, owner=True, dh="0x" + "33" * 32),
    ]
    r = reconcile([], spends, chain_id=CHAIN, wallet=WALLET)
    c = r.chain
    assert c["spends"] == 3
    assert c["total_usdc"] == 0.2
    assert c["owner_approved"] == 2 and c["agent_only"] == 1
    assert c["owner_approved_share"] == 0.6667
    assert c["payees"] == 1 and c["payee_concentration"] == 1.0
    assert c["first_block"] == 1 and c["last_block"] == 3


def test_an_empty_chain_picture_says_zero_rather_than_guessing():
    r = reconcile([], [], chain_id=CHAIN, wallet=WALLET)
    assert r.chain == {"spends": 0}
    assert r.clean


def test_reach_is_carried_through_untouched():
    """A verdict over a range that was only partly read is not a verdict, so the
    caller must be able to see which it has."""
    reach = {"from_block": 1, "to_block": 5000, "pages": 1, "shrinks": 0}
    r = reconcile([], [], reach=reach)
    assert r.as_dict()["reach"] == reach
