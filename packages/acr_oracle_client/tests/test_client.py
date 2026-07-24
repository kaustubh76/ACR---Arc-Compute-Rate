"""acr_oracle_client tests (offline path)."""

from __future__ import annotations

from acr_core import ACRPrint
from acr_oracle_client import OracleClient, PostPayload, index_id_to_bytes32, to_wad
from acr_oracle_client.client import PRINT_TYPES, print_domain, sign_print


def test_index_id_to_bytes32_roundtrips_prefix():
    b = index_id_to_bytes32("ACR-INF")
    assert len(b) == 32
    assert b.rstrip(b"\x00") == b"ACR-INF"


def test_payload_scales_and_serializes():
    p = ACRPrint(
        index_id="ACR-INF",
        ts=100.0,
        value=0.5,
        ci_lo=0.48,
        ci_hi=0.52,
        attack_cost_per_bp=1234.5,
        n_obs=100,
    )
    payload = PostPayload.from_print(p)
    assert payload.value == to_wad(0.5)
    assert payload.ci_lo <= payload.value <= payload.ci_hi
    assert payload.attack_cost_per_bp == int(round(1234.5 * 10**6))
    assert payload.timestamp == 100
    assert len(payload.as_args()) == 6
    assert len(payload.signed_args(27, b"\x00" * 32, b"\x00" * 32)) == 9


def test_print_digest_matches_solidity_formula():
    """The eth_account EIP-712 digest must equal ``ACROracle.printDigest`` — i.e.
    the exact keccak/abi.encode the contract computes. Replicated here so the
    Python signer and the Solidity verifier can never silently diverge."""
    from eth_abi import encode as abi_encode
    from eth_account.messages import _hash_eip191_message, encode_typed_data
    from eth_utils import keccak

    chain_id = 31337
    addr = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    idx = index_id_to_bytes32("ACR-INF")
    value, lo, hi, bound, ts = 5 * 10**17, 48 * 10**16, 52 * 10**16, 1000 * 10**6, 100

    domain_th = keccak(
        text="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    )
    print_th = keccak(
        text="Print(bytes32 indexId,uint256 value,uint256 ciLo,uint256 ciHi,"
        "uint256 attackCostPerBp,uint64 timestamp)"
    )
    dom = keccak(
        abi_encode(
            ["bytes32", "bytes32", "bytes32", "uint256", "address"],
            [domain_th, keccak(text="ACR Oracle"), keccak(text="1"), chain_id, addr],
        )
    )
    struct_hash = keccak(
        abi_encode(
            ["bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint64"],
            [print_th, idx, value, lo, hi, bound, ts],
        )
    )
    digest_manual = keccak(b"\x19\x01" + dom + struct_hash)

    msg = {
        "indexId": idx, "value": value, "ciLo": lo, "ciHi": hi,
        "attackCostPerBp": bound, "timestamp": ts,
    }
    signable = encode_typed_data(
        domain_data=print_domain(chain_id, addr), message_types=PRINT_TYPES, message_data=msg
    )
    assert _hash_eip191_message(signable) == digest_manual


def test_sign_print_recovers_to_signer():
    """A signed print recovers to the signing key's address (what the contract's
    ecrecover + isSigner check enforces on-chain)."""
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    addr = Account.from_key(key).address
    chain_id, oracle = 31337, "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    p = ACRPrint(index_id="ACR-INF", ts=3600.0, value=0.5, ci_lo=0.49, ci_hi=0.51,
                 attack_cost_per_bp=1234.0)
    payload = PostPayload.from_print(p)
    v, r, s = sign_print(payload, chain_id, oracle, key)
    assert v in (27, 28)
    message = {
        "indexId": payload.index_id, "value": payload.value, "ciLo": payload.ci_lo,
        "ciHi": payload.ci_hi, "attackCostPerBp": payload.attack_cost_per_bp,
        "timestamp": payload.timestamp,
    }
    signable = encode_typed_data(
        domain_data=print_domain(chain_id, oracle), message_types=PRINT_TYPES, message_data=message
    )
    recovered = Account.recover_message(
        signable, vrs=(v, int.from_bytes(r, "big"), int.from_bytes(s, "big"))
    )
    assert recovered == addr


def test_client_offline_returns_none():
    client = OracleClient(rpc_url="http://127.0.0.1:1", oracle_address=None, private_key=None)
    p = ACRPrint(index_id="ACR-INF", ts=1.0, value=0.5, ci_lo=0.4, ci_hi=0.6, attack_cost_per_bp=10.0)
    assert client.can_post() is False
    assert client.post(p) is None


def test_registry_client_offline_is_tolerant():
    from acr_oracle_client import RegistryClient, bytes32_to_schema, schema_to_bytes32

    rc = RegistryClient(rpc_url="http://127.0.0.1:1", registry_address=None)
    assert rc.connected() is False
    assert rc.all_attestations() == []
    assert rc.get_attestation("0x" + "0" * 40) is None
    # schema encoding round-trips within 32 bytes.
    assert bytes32_to_schema(schema_to_bytes32("inf.v1")) == "inf.v1"


def test_registry_code_maps_match_contract():
    from acr_core import ModelClass, Service
    from acr_oracle_client.registry import CLASS_TO_CODE, SERVICE_TO_CODE

    # Must match AttestationRegistry.sol comments and arc_source.SERVICE_CODES.
    assert SERVICE_TO_CODE[Service.INFERENCE] == 0
    assert SERVICE_TO_CODE[Service.GPU] == 1
    assert SERVICE_TO_CODE[Service.DATA] == 2
    assert CLASS_TO_CODE[ModelClass.FRONTIER] == 0
    assert CLASS_TO_CODE[ModelClass.OPEN] == 3
