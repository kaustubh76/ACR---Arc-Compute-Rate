"""The feed pass, end to end on a real chain — runs only when anvil is reachable.

The other seventeen feed-pass tests stub `sign_feed_access` and `relay_redeem`
and point at a fake attestor, so every one of them passes against a pass that
was never minted. What they cannot see is the part that decides whether a
paying reader gets served: a USDC transfer that only exists as logs on chain,
an EIP-712 signature that has to recover to a signer the attestor accepts, and
a `redeem` whose reverts ("bad signer", "nonce used", "window too long") are
the contract's, not ours.

So this one uses no fakes. It deploys MockUSDC and a real FeedAccessAttestor to
anvil, makes an actual transfer, and drives the real `feedpass.verify_payment`
-> `feedpass.mint` -> `feedpass.access` path. The only substitution is the
payer: a raw key here, a Circle smart account in production, which the chain
cannot tell apart.

Skipped (not failed) without a node, so the default `make test` stays hermetic.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

RPC = "http://127.0.0.1:8545"
ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# A second funded anvil account stands in for the reader's wallet, so "the payer
# is not the press" is part of what is proven rather than an accident.
READER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
_OUT = Path(__file__).resolve().parents[3] / "contracts/out"
ATTESTOR_ART = _OUT / "FeedAccessAttestor.sol/FeedAccessAttestor.json"
USDC_ART = _OUT / "MockUSDC.sol/MockUSDC.json"

pytestmark = pytest.mark.skipif(
    not (ATTESTOR_ART.exists() and USDC_ART.exists()),
    reason="contracts not built (run forge build)",
)


def _anvil():
    try:
        from eth_account import Account
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 2}))
        if not w3.is_connected():
            return None
        return w3, Account.from_key(ANVIL_KEY), Account.from_key(READER_KEY)
    except Exception:  # noqa: BLE001 - no node, no web3, same outcome
        return None


def _deploy(w3, acct, artifact: Path):
    art = json.loads(artifact.read_text())
    c = w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"]["object"])
    tx = c.constructor().build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
         "gas": 3_000_000, "chainId": w3.eth.chain_id}
    )
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    rcpt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(raw), timeout=30)
    assert rcpt.status == 1
    return rcpt.contractAddress


def _send(w3, acct, fn):
    tx = fn.build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
         "gas": 400_000, "chainId": w3.eth.chain_id}
    )
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    h = w3.eth.send_raw_transaction(raw)
    rcpt = w3.eth.wait_for_transaction_receipt(h, timeout=30)
    return h.hex() if isinstance(h, bytes) else str(h), rcpt


def test_a_real_transfer_becomes_a_real_pass(monkeypatch):
    conn = _anvil()
    if conn is None:
        pytest.skip("anvil not reachable at 127.0.0.1:8545")
    w3, press, reader = conn

    from acr_core import reset_settings
    from acr_oracle_client import build_role_signer
    from acr_oracle_client import feed_access as fa
    from index_api import feedpass

    usdc = _deploy(w3, press, USDC_ART)
    attestor = _deploy(w3, press, ATTESTOR_ART)  # constructor grants the press a signer bit

    # Everything the pass reads comes from settings, so configure the seller the
    # way a mainnet deployment would: the press signs, the reader pays, the
    # seller's own wallet receives.
    seller = press.address
    for k, v in {
        "ACR_USDC_ADDRESS": usdc,
        "ACR_ATTESTOR_ADDRESS": attestor,
        "ACR_X402_PAY_TO": seller,
        "ACR_PASS_PRICE_USDC": "1.0",
        "ACR_PASS_WINDOW_S": "86400",
        "ACR_PASS_CLAIM_MAX_AGE_S": "3600",
        "ACR_ARC_CHAIN_ID": str(w3.eth.chain_id),
    }.items():
        monkeypatch.setenv(k, v)
    reset_settings()
    feedpass.forget(reader.address)

    erc20 = w3.eth.contract(address=w3.to_checksum_address(usdc), abi=json.loads(USDC_ART.read_text())["abi"])
    price = 1_000_000  # 1.0 USDC, 6 decimals — the ERC-20 view, never the native 18
    _send(w3, press, erc20.functions.mint(reader.address, price * 3))

    # No pass before paying. This is the state a stranger is in.
    assert feedpass.access(w3, reader.address) == (False, 0)

    # 1 — the reader pays on chain. Nothing about this transfer knows about ACR.
    tx_hash, rcpt = _send(w3, reader, erc20.functions.transfer(seller, price))
    assert rcpt.status == 1

    # 2 — the seller verifies it FROM THE CHAIN: amount, recipient, sender, age.
    paid, age = feedpass.verify_payment(w3, tx_hash, sender=reader.address)
    assert paid == price, "the verifier must read the amount out of the logs, not be told it"
    assert age >= 0

    # 3 — the press signs a FeedAccess and relays the redeem. `mint` takes the
    # repo's own role signer (the same object production builds, via
    # `build_role_signer("poster")`), not a bare eth_account — the two have
    # different `sign_typed_data` signatures, and only the wrapper's is EIP-712
    # by parts. Real recovery inside the contract: a domain or field-order
    # mismatch surfaces here as "bad signer", not as a silent wrong answer.
    press_signer = build_role_signer("poster", private_key=ANVIL_KEY)
    assert press_signer is not None and press_signer.address == press.address
    out = feedpass.mint(w3, press_signer, wallet=reader.address, tx_hash=tx_hash)
    assert out["has_access"] is True, out
    assert out["payment_tx"] == tx_hash
    assert str(out["attest_tx"]).startswith("0x"), "the relay's own tx hash, from the chain"
    until = int(out["paid_until"])
    assert until > w3.eth.get_block("latest")["timestamp"]

    # 4 — and the gate's own question now answers yes, read from the contract.
    feedpass.forget(reader.address)
    has, until_chain = feedpass.access(w3, reader.address)
    assert has is True
    assert until_chain == until
    ok, until_direct = fa.access_of(w3, attestor, reader.address)
    assert (ok, until_direct) == (True, until), "the memoised read must match the contract"

    # 5 — the same receipt cannot be spent twice. The nonce is the tx hash, so
    # this is the contract refusing, not our bookkeeping.
    with pytest.raises(feedpass.PassError) as e:
        feedpass.mint(w3, press_signer, wallet=reader.address, tx_hash=tx_hash)
    assert e.value.status == 409

    reset_settings()


def test_a_short_payment_never_becomes_a_pass(monkeypatch):
    """The refusal path, also on chain: half the price buys nothing, and the
    reader is told by how much they are short rather than just refused."""
    conn = _anvil()
    if conn is None:
        pytest.skip("anvil not reachable at 127.0.0.1:8545")
    w3, press, reader = conn

    from acr_core import reset_settings
    from index_api import feedpass

    usdc = _deploy(w3, press, USDC_ART)
    attestor = _deploy(w3, press, ATTESTOR_ART)
    for k, v in {
        "ACR_USDC_ADDRESS": usdc,
        "ACR_ATTESTOR_ADDRESS": attestor,
        "ACR_X402_PAY_TO": press.address,
        "ACR_PASS_PRICE_USDC": "1.0",
        "ACR_ARC_CHAIN_ID": str(w3.eth.chain_id),
    }.items():
        monkeypatch.setenv(k, v)
    reset_settings()

    erc20 = w3.eth.contract(address=w3.to_checksum_address(usdc), abi=json.loads(USDC_ART.read_text())["abi"])
    _send(w3, press, erc20.functions.mint(reader.address, 1_000_000))
    tx_hash, _ = _send(w3, reader, erc20.functions.transfer(press.address, 400_000))

    with pytest.raises(feedpass.PassError) as e:
        feedpass.verify_payment(w3, tx_hash, sender=reader.address)
    assert e.value.status == 402
    # The refusal names both numbers, so a reader can see the gap themselves.
    assert "0.400000" in e.value.detail and "1.000000" in e.value.detail, e.value.detail
    feedpass.forget(reader.address)
    assert feedpass.access(w3, reader.address) == (False, 0)
    reset_settings()
