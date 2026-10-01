"""The whole workflow, start to finish, against a real chain.

RFB 4 asks to demonstrate "at least one complete business workflow, run by the
agent from start to finish". This is it, and it runs only when a local anvil is
reachable: a real PolicyWallet, a real ERC-20, a real budget, the operator's own
receipts as the meter, observed quotes as the benchmark, and a payment that
either happens on chain or does not.

The claim that makes the ledger worth anything is the last assertion in
``test_a_fair_bill_is_paid_and_the_chain_holds_the_reasoning``: the decision
record the operator wrote down hashes to the ``decisionHash`` the contract
stored. Without that, "signed decision receipts" is a filing cabinet. With it, a
record that no longer matches its commitment was edited after the payment.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from acr_oracle_client.policy import PolicyClient, category_id, decision_hash
from acr_oracle_client.signer import LocalKeySigner
from index_api.operator import ESCALATE, PAY, Obligation, run_obligation
from web3.logs import DISCARD

RPC = "http://127.0.0.1:8545"
OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

_OUT = Path(__file__).resolve().parents[3] / "contracts/out"
WALLET_ARTIFACT = _OUT / "PolicyWallet.sol/PolicyWallet.json"
USDC_ARTIFACT = _OUT / "MockUSDC.sol/MockUSDC.json"

USDC = 10**6
CATEGORY = "infra"
RES = "https://acr.example/compute/inference"

VENDOR = "0x1111111111111111111111111111111111111111"
RIVAL_A = "0x2222222222222222222222222222222222222222"
RIVAL_B = "0x3333333333333333333333333333333333333333"


def _anvil():
    try:
        from eth_account import Account
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 2}))
        if not w3.is_connected():
            return None
        return w3, Account.from_key(OWNER_KEY), Account.from_key(AGENT_KEY)
    except Exception:
        return None


def _send(w3, acct, tx):
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    return w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(raw), timeout=30)


def _deploy(w3, acct, artifact: Path, *args):
    art = json.loads(artifact.read_text())
    c = w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"]["object"])
    tx = c.constructor(*args).build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
         "gas": 5_000_000, "chainId": w3.eth.chain_id}
    )
    return _send(w3, acct, tx).contractAddress


@pytest.fixture(scope="module")
def business():
    """One onboarded business: a funded wallet, a budget, an authorized agent."""
    node = _anvil()
    if node is None:
        pytest.skip("no anvil at 127.0.0.1:8545")
    if not WALLET_ARTIFACT.exists() or not USDC_ARTIFACT.exists():
        pytest.skip("contracts not built (run: cd contracts && forge build)")
    w3, owner, agent = node

    usdc_addr = _deploy(w3, owner, USDC_ARTIFACT)
    wallet_addr = _deploy(w3, owner, WALLET_ARTIFACT, usdc_addr)

    usdc = w3.eth.contract(address=usdc_addr, abi=json.loads(USDC_ARTIFACT.read_text())["abi"])
    wallet = w3.eth.contract(
        address=wallet_addr, abi=json.loads(WALLET_ARTIFACT.read_text())["abi"]
    )

    def owner_tx(fn):
        return _send(w3, owner, fn.build_transaction(
            {"from": owner.address, "nonce": w3.eth.get_transaction_count(owner.address),
             "gas": 1_000_000, "chainId": w3.eth.chain_id}))

    owner_tx(usdc.functions.mint(wallet_addr, 10_000 * USDC))
    owner_tx(wallet.functions.setAgent(agent.address, True))
    # 1,000 USDC a month; the agent alone may send under 100.
    owner_tx(wallet.functions.setBudget(
        category_id(CATEGORY), 1_000 * USDC, 100 * USDC, 30 * 24 * 3600))

    policy = PolicyClient(
        rpc_url=RPC, wallet_address=wallet_addr,
        agent_signer=LocalKeySigner(AGENT_KEY), owner_signer=LocalKeySigner(OWNER_KEY),
    )
    return w3, wallet, usdc, policy


# Three sellers of the same service at the same price: a real benchmark.
CATALOG = {
    "items": [
        {"resource": RES, "accepts": [{"amount": "2000000", "payTo": VENDOR}]},
        {"resource": RES, "accepts": [{"amount": "2000000", "payTo": RIVAL_A}]},
        {"resource": RES, "accepts": [{"amount": "2000000", "payTo": RIVAL_B}]},
    ]
}
#: A genuinely expensive service, so a large bill can be at par. Needed because
#: billing 150 for a 2-USDC service is an over-par REROUTE, not a budget
#: question: the price check outranks the budget check by design.
BIG_RES = "https://acr.example/compute/cluster-hour"
CATALOG["items"] += [
    {"resource": BIG_RES, "accepts": [{"amount": "150000000", "payTo": VENDOR}]},
    {"resource": BIG_RES, "accepts": [{"amount": "150000000", "payTo": RIVAL_A}]},
    {"resource": BIG_RES, "accepts": [{"amount": "150000000", "payTo": RIVAL_B}]},
]

# Our own settlement history with this vendor: 1,000 units consumed.
RECEIPTS = [
    {"seller": VENDOR, "resource": RES, "quantity": 1_000.0, "amount_usdc": 2.0,
     "settled_at": 1.0},
]


def test_a_fair_bill_is_paid_and_the_chain_holds_the_reasoning(business, tmp_path):
    w3, wallet, usdc, policy = business
    before = usdc.functions.balanceOf(VENDOR).call()

    ob = Obligation(
        obligation_id="inv-fair-1", vendor=VENDOR, billed_usdc=2.0,
        category=CATEGORY, resource=RES, vendor_quantity=1_000.0,
        invoice_ref="ACME-0001",
    )
    d = run_obligation(
        ob, receipts=RECEIPTS, catalog=CATALOG, policy=policy,
        dry_run=False, log_path=str(tmp_path / "decisions.jsonl"),
    )

    assert d.intent == PAY, d.rule
    assert d.metered_quantity == pytest.approx(1_000.0)
    assert d.par_usdc == pytest.approx(2.0)
    assert usdc.functions.balanceOf(VENDOR).call() == before + 2 * USDC
    assert d.tx

    # The budget was read from the contract and moved by exactly the payment.
    b = policy.budget(CATEGORY)
    assert b["spent_usdc"] == pytest.approx(2.0)

    # THE claim: what we wrote down hashes to what the chain stored.
    logged = json.loads((tmp_path / "decisions.jsonl").read_text().splitlines()[0])
    logged.pop("tx", None)
    logged.pop("paid_usdc", None)
    events = wallet.events.Spent().process_receipt(
        w3.eth.get_transaction_receipt(d.tx), errors=DISCARD
    )
    assert len(events) == 1
    assert bytes(events[0]["args"]["decisionHash"]) == decision_hash(logged), (
        "the record on disk does not hash to the commitment on chain"
    )
    assert events[0]["args"]["ownerApproved"] is False


def test_an_overbilling_vendor_is_caught_before_the_money_moves(business, tmp_path):
    """They billed for 5,000 units; our own receipts account for 1,000."""
    _, _, usdc, policy = business
    before = usdc.functions.balanceOf(VENDOR).call()
    spent_before = policy.budget(CATEGORY)["spent_usdc"]

    ob = Obligation(
        obligation_id="inv-overbilled-1", vendor=VENDOR, billed_usdc=10.0,
        category=CATEGORY, resource=RES, vendor_quantity=5_000.0,
    )
    d = run_obligation(
        ob, receipts=RECEIPTS, catalog=CATALOG, policy=policy,
        dry_run=False, log_path=str(tmp_path / "decisions.jsonl"),
    )

    assert d.intent == ESCALATE
    assert "metered below billed" in d.rule
    assert d.discrepancy == pytest.approx(4_000.0)
    assert usdc.functions.balanceOf(VENDOR).call() == before, "nothing moved"
    assert policy.budget(CATEGORY)["spent_usdc"] == pytest.approx(spent_before)


def test_a_payment_over_the_threshold_is_not_the_agents_to_make(business, tmp_path):
    """Above the per-transaction limit the contract itself refuses the agent, so
    the operator must escalate rather than try and revert."""
    _, _, usdc, policy = business
    before = usdc.functions.balanceOf(VENDOR).call()

    ob = Obligation(
        obligation_id="inv-large-1", vendor=VENDOR, billed_usdc=150.0,
        category=CATEGORY, resource=BIG_RES,
    )
    d = run_obligation(
        ob, receipts=RECEIPTS, catalog=CATALOG, policy=policy,
        dry_run=False, log_path=str(tmp_path / "decisions.jsonl"),
    )

    assert d.intent == ESCALATE and d.escalated is True
    assert "the owner signs this one" in d.rule
    assert usdc.functions.balanceOf(VENDOR).call() == before


def test_the_budget_the_operator_reads_is_the_one_the_contract_enforces(business):
    """Not a local tally. A second opinion about the authoritative number drifts
    the moment anything else spends from the same wallet."""
    _, wallet, _, policy = business

    from_client = policy.budget(CATEGORY)
    exists, cap, spent, per_tx, _, _ = wallet.functions.budgetOf(
        category_id(CATEGORY)
    ).call()

    assert exists is True
    assert from_client["cap_usdc"] == pytest.approx(cap / USDC)
    assert from_client["spent_usdc"] == pytest.approx(spent / USDC)
    assert from_client["per_tx_limit_usdc"] == pytest.approx(per_tx / USDC)


def test_an_overpriced_large_bill_is_rerouted_rather_than_escalated(business, tmp_path):
    """Order, against a real chain: a bill far over par with cheaper sellers
    available comes back as 'there is a cheaper seller' — actionable — not as
    'that needs the owner', which would send a human to approve an overpay."""
    _, _, usdc, policy = business
    before = usdc.functions.balanceOf(VENDOR).call()

    ob = Obligation(
        obligation_id="inv-overpriced-large", vendor=VENDOR, billed_usdc=150.0,
        category=CATEGORY, resource=RES,  # par here is 2.0
    )
    d = run_obligation(
        ob, receipts=RECEIPTS, catalog=CATALOG, policy=policy,
        dry_run=False, log_path=str(tmp_path / "decisions.jsonl"),
    )

    assert d.intent == "reroute"
    assert d.reroute_to in {RIVAL_A, RIVAL_B}
    assert d.saving_usdc == pytest.approx(148.0)
    assert usdc.functions.balanceOf(VENDOR).call() == before
