"""Signer tests — the Local/Circle signer abstraction, all mocked (no SDK, no chain)."""

from __future__ import annotations

import json

from acr_core import ACRPrint
from acr_oracle_client import (
    CircleWalletSigner,
    LocalKeySigner,
    OracleClient,
    PostPayload,
    build_signer,
    full_eip712_json,
)
from acr_oracle_client.client import PRINT_TYPES, print_domain, sign_print

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ORACLE = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
CHAIN = 31337


def _payload_message():
    p = ACRPrint(index_id="ACR-INF", ts=3600.0, value=0.5, ci_lo=0.49, ci_hi=0.51,
                 attack_cost_per_bp=1234.0)
    payload = PostPayload.from_print(p)
    message = {
        "indexId": payload.index_id, "value": payload.value, "ciLo": payload.ci_lo,
        "ciHi": payload.ci_hi, "attackCostPerBp": payload.attack_cost_per_bp,
        "timestamp": payload.timestamp,
    }
    return payload, message


def test_localkeysigner_matches_sign_print():
    payload, message = _payload_message()
    ref = sign_print(payload, CHAIN, ORACLE, KEY)
    got = LocalKeySigner(KEY).sign_typed_data(print_domain(CHAIN, ORACLE), PRINT_TYPES, message, "Print")
    assert got == ref  # byte-identical to the pre-Circle path


def test_full_eip712_json_digest_parity():
    # The full-JSON form (what Circle signs) must hash to the same EIP-712 digest
    # as eth_account's partial-dict form (what sign_print uses).
    from eth_account.messages import _hash_eip191_message, encode_typed_data

    _, message = _payload_message()
    domain = print_domain(CHAIN, ORACLE)
    partial = encode_typed_data(domain_data=domain, message_types=PRINT_TYPES, message_data=message)
    doc = full_eip712_json(domain, PRINT_TYPES, "Print", message)
    full = encode_typed_data(full_message=doc)
    assert _hash_eip191_message(partial) == _hash_eip191_message(full)


def test_full_eip712_json_encodes_uints_as_strings():
    # Regression: WAD-scaled (1e18) uints must serialize as JSON *strings*. A raw
    # JSON number loses precision above 2^53 when Circle's server parses it,
    # corrupting the signed hash — the signature would then be silently invalid.
    from eth_account.messages import _hash_eip191_message, encode_typed_data

    domain = print_domain(CHAIN, ORACLE)
    message = {
        "indexId": b"\x11" * 32, "value": 497_000_000_000_000_000,  # > 2^53
        "ciLo": 496_000_000_000_000_000, "ciHi": 499_000_000_000_000_000,
        "attackCostPerBp": 8963, "timestamp": 43200,
    }
    doc = full_eip712_json(domain, PRINT_TYPES, "Print", message)
    assert doc["message"]["value"] == "497000000000000000"  # string, not a JSON number
    assert doc["message"]["indexId"].startswith("0x")  # bytes32 hex-encoded

    # Survives the JSON string round-trip transport does, with no precision loss,
    # and still hashes to the same EIP-712 digest as the integer form.
    round_tripped = json.loads(json.dumps(doc))
    assert round_tripped["message"]["value"] == "497000000000000000"
    partial = encode_typed_data(domain_data=domain, message_types=PRINT_TYPES, message_data=message)
    full = encode_typed_data(full_message=round_tripped)
    assert _hash_eip191_message(partial) == _hash_eip191_message(full)


class _FakeCircle:
    """A stand-in Circle client that signs with a local key (no SDK, no network)."""

    def __init__(self, key: str) -> None:
        from eth_account import Account

        self._acct = Account.from_key(key)
        self.last_exec = None

    def wallet_address(self, wallet_id: str) -> str:
        return self._acct.address

    def sign_typed_data(self, wallet_id: str, typed_data_json: str) -> str:
        from eth_account import Account

        signed = Account.sign_typed_data(self._acct.key, full_message=json.loads(typed_data_json))
        return signed.signature.hex()

    def contract_execution(self, wallet_id, contract_address, call_data, idempotency_key) -> str:
        self.last_exec = (contract_address, call_data, idempotency_key)
        return "0x" + "ab" * 32


def test_circle_signer_signs_and_recovers():
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    fake = _FakeCircle(KEY)
    signer = CircleWalletSigner(wallet_id="wallet-1", client=fake)
    assert signer.address == fake.wallet_address("wallet-1")

    _, message = _payload_message()
    v, r, s = signer.sign_typed_data(print_domain(CHAIN, ORACLE), PRINT_TYPES, message, "Print")
    assert v in (27, 28)
    signable = encode_typed_data(
        domain_data=print_domain(CHAIN, ORACLE), message_types=PRINT_TYPES, message_data=message
    )
    recovered = Account.recover_message(
        signable, vrs=(v, int.from_bytes(r, "big"), int.from_bytes(s, "big"))
    )
    assert recovered == signer.address  # what the contract's ecrecover + isSigner enforces


def test_circle_signer_send_uses_calldata_and_uuid():
    import uuid

    fake = _FakeCircle(KEY)
    signer = CircleWalletSigner(wallet_id="wallet-1", client=fake)
    tx = {"to": ORACLE, "data": "0xdeadbeef", "from": signer.address, "nonce": 0, "chainId": CHAIN}
    tx_hash = signer.send_transaction(None, tx)
    assert tx_hash == "0x" + "ab" * 32
    contract_addr, call_data, idem = fake.last_exec
    assert contract_addr == ORACLE and call_data == "0xdeadbeef"
    uuid.UUID(idem)  # raises if not a valid UUID


def test_build_signer_selection(monkeypatch):
    from acr_core import get_settings, reset_settings

    # No creds → None (offline).
    reset_settings()
    assert build_signer(get_settings()) is None

    # Explicit key → LocalKeySigner.
    s = build_signer(get_settings(), private_key=KEY)
    assert isinstance(s, LocalKeySigner)

    # Circle creds → CircleWalletSigner.
    monkeypatch.setenv("ACR_CIRCLE_API_KEY", "TEST:1:secret")
    monkeypatch.setenv("ACR_CIRCLE_WALLET_ID", "wallet-1")
    reset_settings()
    try:
        assert isinstance(build_signer(get_settings()), CircleWalletSigner)
    finally:
        reset_settings()


def test_build_signer_ignores_malformed_creds():
    from acr_core.config import ACRSettings

    # Comment-polluted or partial Circle creds must fail safe to offline (None),
    # not select the live CircleWalletSigner.
    s = ACRSettings(_env_file=None, circle_api_key="# PREFIX:ID:SECRET", circle_wallet_id="# wallet")
    assert build_signer(s) is None
    s2 = ACRSettings(_env_file=None, circle_api_key="real-key")  # no wallet id
    assert build_signer(s2) is None


def test_oracle_client_offline_and_backcompat():
    # No signer → offline.
    c = OracleClient(rpc_url="http://127.0.0.1:1", oracle_address=None, private_key=None)
    assert c.signer is None and c.can_post() is False
    p = ACRPrint(index_id="ACR-INF", ts=1.0, value=0.5, ci_lo=0.4, ci_hi=0.6, attack_cost_per_bp=10.0)
    assert c.post(p) is None
    # Explicit private_key → LocalKeySigner (the anvil/demo path).
    c2 = OracleClient(rpc_url="http://127.0.0.1:1", oracle_address=ORACLE, private_key=KEY)
    assert isinstance(c2.signer, LocalKeySigner)
    assert c2.signer.address == LocalKeySigner(KEY).address
