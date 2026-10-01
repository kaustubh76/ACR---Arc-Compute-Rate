"""PolicyWallet round-trip — runs only when a local anvil node is reachable.

Deploys the real compiled PolicyWallet against a real ERC-20, and spends through
``PolicyClient`` exactly as the operator does. Skipped (not failed) without a
node, so the default ``make test`` stays hermetic.

The claim that matters most is the one no mock can make: **the digest Python
signs is byte-for-byte the digest the contract recovers against.** An EIP-712
type mismatch between the two sides recovers to a stranger, so the only symptom
would be "not owner signature" on an approval a human really did give — after
the gas was spent, and with no way to tell it from a forgery.

The second claim is that the authority ladder holds against Solidity rather than
against Python's opinion of it: below the threshold the agent pays, at the
threshold it cannot, and with the owner's signature it can.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from acr_oracle_client.policy import (
    APPROVAL_TYPES,
    USDC,
    PolicyClient,
    category_id,
    decision_hash,
)
from acr_oracle_client.signer import LocalKeySigner
from web3.logs import DISCARD

RPC = "http://127.0.0.1:8545"
# anvil's first two deterministic keys: the owner and the agent must be
# different parties or the threshold proves nothing.
OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

_OUT = Path(__file__).resolve().parents[3] / "contracts/out"
WALLET_ARTIFACT = _OUT / "PolicyWallet.sol/PolicyWallet.json"
USDC_ARTIFACT = _OUT / "MockUSDC.sol/MockUSDC.json"

VENDOR = "0x3333333333333333333333333333333333333333"
CATEGORY = "infra"
CAP = 1_000 * USDC
PER_TX = 100 * USDC
MONTH = 30 * 24 * 3600


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
        {
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": 5_000_000,
            "chainId": w3.eth.chain_id,
        }
    )
    return _send(w3, acct, tx).contractAddress


@pytest.fixture(scope="module")
def chain():
    node = _anvil()
    if node is None:
        pytest.skip("no anvil at 127.0.0.1:8545")
    if not WALLET_ARTIFACT.exists() or not USDC_ARTIFACT.exists():
        pytest.skip("contracts not built (run: cd contracts && forge build)")
    return node


@pytest.fixture(scope="module")
def deployed(chain):
    """A funded wallet with one configured category and the agent authorized."""
    w3, owner, agent = chain

    usdc_addr = _deploy(w3, owner, USDC_ARTIFACT)
    wallet_addr = _deploy(w3, owner, WALLET_ARTIFACT, usdc_addr)

    usdc_abi = json.loads(USDC_ARTIFACT.read_text())["abi"]
    wallet_abi = json.loads(WALLET_ARTIFACT.read_text())["abi"]
    usdc = w3.eth.contract(address=usdc_addr, abi=usdc_abi)
    wallet = w3.eth.contract(address=wallet_addr, abi=wallet_abi)

    def owner_tx(fn):
        return _send(
            w3,
            owner,
            fn.build_transaction(
                {
                    "from": owner.address,
                    "nonce": w3.eth.get_transaction_count(owner.address),
                    "gas": 1_000_000,
                    "chainId": w3.eth.chain_id,
                }
            ),
        )

    owner_tx(usdc.functions.mint(wallet_addr, 10_000 * USDC))
    owner_tx(wallet.functions.setAgent(agent.address, True))
    owner_tx(wallet.functions.setBudget(category_id(CATEGORY), CAP, PER_TX, MONTH))

    client = PolicyClient(
        rpc_url=RPC,
        wallet_address=wallet_addr,
        agent_signer=LocalKeySigner(AGENT_KEY),
        owner_signer=LocalKeySigner(OWNER_KEY),
    )
    return w3, wallet, usdc, client


# --- the parity claim ------------------------------------------------------

def test_the_digest_python_signs_is_the_digest_solidity_recovers_against(deployed):
    """Byte-for-byte, against the contract's own arithmetic. A mismatch here is
    invisible until a real approval is rejected as a forgery."""
    from eth_account.messages import _hash_eip191_message, encode_typed_data
    from web3 import Web3

    _, wallet, _, client = deployed
    record = {"billed": 250.0, "metered": 249.1, "par": 240.0, "rule": "over-par-reroute"}
    dh = decision_hash(record)
    deadline = client.deadline_in(600)
    nonce = client.approval_nonce()

    message = {
        "category": category_id(CATEGORY),
        "to": Web3.to_checksum_address(VENDOR),
        "amount": 250 * USDC,
        "decisionHash": dh,
        "nonce": nonce,
        "deadline": deadline,
    }
    ours = _hash_eip191_message(
        encode_typed_data(
            domain_data=client._domain(client._connect().eth.chain_id),
            message_types=APPROVAL_TYPES,
            message_data=message,
        )
    )
    theirs = wallet.functions.approvalDigest(
        category_id(CATEGORY),
        Web3.to_checksum_address(VENDOR),
        250 * USDC,
        dh,
        nonce,
        deadline,
    ).call()

    assert ours == theirs, "Python and Solidity disagree on the approval digest"


def test_the_domain_separator_matches_the_one_the_client_builds(deployed):
    """The separator pins the name, version, chain and address together. If the
    client's string ever drifts from the contract's, every signature it makes is
    valid for a wallet that does not exist."""
    from eth_abi import encode as abi_encode
    from web3 import Web3

    _, wallet, _, client = deployed
    d = client._domain(client._connect().eth.chain_id)
    expected = Web3.keccak(
        abi_encode(
            ["bytes32", "bytes32", "bytes32", "uint256", "address"],
            [
                Web3.keccak(
                    text="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                Web3.keccak(text=d["name"]),
                Web3.keccak(text=d["version"]),
                d["chainId"],
                d["verifyingContract"],
            ],
        )
    )
    assert wallet.functions.DOMAIN_SEPARATOR().call() == expected


# --- the authority ladder, against Solidity --------------------------------

def test_the_agent_pays_below_the_threshold(deployed):
    w3, wallet, usdc, client = deployed
    before = usdc.functions.balanceOf(VENDOR).call()

    record = {"billed": 40.0, "metered": 40.0, "par": 40.0, "rule": "at-par-pay-now"}
    client.spend(CATEGORY, VENDOR, 40, record)

    assert usdc.functions.balanceOf(VENDOR).call() == before + 40 * USDC
    b = client.budget(CATEGORY)
    assert b is not None and b["spent_usdc"] >= 40.0


def test_the_stored_commitment_is_the_hash_of_the_record_we_kept(deployed):
    """The euthyna claim: the chain holds a commitment to the reasoning. A record
    that no longer hashes to the stored value was edited after the payment."""
    w3, wallet, _, client = deployed
    record = {"billed": 11.0, "metered": 10.5, "par": 10.0, "rule": "metered-below-billed"}

    tx = client.spend(CATEGORY, VENDOR, 11, record)
    rcpt = w3.eth.get_transaction_receipt(tx)
    logs = wallet.events.Spent().process_receipt(rcpt, errors=DISCARD)

    assert len(logs) == 1
    assert bytes(logs[0]["args"]["decisionHash"]) == decision_hash(record)
    assert logs[0]["args"]["ownerApproved"] is False, "the agent acted alone"


def test_at_the_threshold_the_agent_alone_is_refused(deployed):
    _, _, usdc, client = deployed
    before = usdc.functions.balanceOf(VENDOR).call()

    with pytest.raises(Exception) as exc:
        client.spend(CATEGORY, VENDOR, 100, {"rule": "too-big"})
    assert "needs owner approval" in str(exc.value) or "revert" in str(exc.value).lower()

    assert usdc.functions.balanceOf(VENDOR).call() == before, "nothing moved"


def test_the_owners_signature_clears_it(deployed):
    w3, wallet, usdc, client = deployed
    before = usdc.functions.balanceOf(VENDOR).call()
    nonce_before = client.approval_nonce()

    record = {"billed": 250.0, "metered": 249.1, "par": 240.0, "rule": "escalated-approved"}
    tx = client.spend_approved(
        CATEGORY, VENDOR, 250, record, deadline=client.deadline_in(600)
    )

    assert usdc.functions.balanceOf(VENDOR).call() == before + 250 * USDC
    assert client.approval_nonce() == nonce_before + 1, "the approval was consumed once"

    logs = wallet.events.Spent().process_receipt(
        w3.eth.get_transaction_receipt(tx), errors=DISCARD
    )
    assert logs[0]["args"]["ownerApproved"] is True, "recorded as a human decision"
    assert bytes(logs[0]["args"]["decisionHash"]) == decision_hash(record)


def test_a_deadline_is_dated_on_the_chains_clock_not_the_hosts(deployed):
    """Measured 3,815 seconds apart on a local anvil. A deadline from
    ``time.time()`` expired an approval that had just been signed."""
    _, _, _, client = deployed
    chain_now = client.chain_now()
    assert chain_now is not None
    assert client.deadline_in(600) == chain_now + 600

    # And the contract agrees it has not expired.
    record = {"billed": 150.0, "metered": 150.0, "par": 150.0, "rule": "escalated-approved"}
    client.spend_approved(CATEGORY, VENDOR, 150, record, deadline=client.deadline_in(600))
