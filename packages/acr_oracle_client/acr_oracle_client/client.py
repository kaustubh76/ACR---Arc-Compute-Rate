"""Sign ACR prints (EIP-712) and post them to ``ACROracle.sol``.

Bridges the Python estimator to the on-chain oracle. Each print is signed with
the EIP-712 typed-data scheme the contract verifies (domain ``ACR Oracle`` v1,
``Print`` struct); the signature — not the sender — authenticates the print, so
any relayer may submit it. Prices are scaled to WAD (1e18) and the attack cost
to USDC-6 (1e6) to match the contract's storage convention. Like ``ArcSource``,
this degrades gracefully: without a configured RPC/private key it returns an
unsigned, unsent payload so the rest of the pipeline (and the demo) still runs
offline.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from acr_core import ACRPrint, get_settings

from .signer import Signer, build_signer

log = logging.getLogger("acr_oracle_client")

WAD = 10**18
USDC = 10**6


def index_id_to_bytes32(index_id: str) -> bytes:
    raw = index_id.encode("utf-8")
    if len(raw) > 32:  # pragma: no cover - defensive
        raise ValueError("index id too long for bytes32")
    return raw.ljust(32, b"\x00")


def to_wad(x: float) -> int:
    return int(round(x * WAD))


def to_usdc(x: float) -> int:
    return int(round(x * USDC))


@dataclass
class PostPayload:
    """The exact calldata a ``postPrint`` transaction carries."""

    index_id: bytes
    value: int
    ci_lo: int
    ci_hi: int
    attack_cost_per_bp: int
    timestamp: int

    @classmethod
    def from_print(cls, p: ACRPrint) -> PostPayload:
        return cls(
            index_id=index_id_to_bytes32(p.index_id),
            value=to_wad(p.value),
            ci_lo=to_wad(p.ci_lo),
            ci_hi=to_wad(p.ci_hi),
            attack_cost_per_bp=max(1, to_usdc(p.attack_cost_per_bp or 0.0)),
            timestamp=int(p.ts),
        )

    def as_args(self) -> tuple:
        """The six signed fields — the EIP-712 message and the digest preimage."""
        return (
            self.index_id,
            self.value,
            self.ci_lo,
            self.ci_hi,
            self.attack_cost_per_bp,
            self.timestamp,
        )

    def signed_args(self, v: int, r: bytes, s: bytes) -> tuple:
        """Full ``postPrint`` calldata: the six fields plus the signature."""
        return (*self.as_args(), v, r, s)


#: EIP-712 typed-data schema for a print — must match ``ACROracle.PRINT_TYPEHASH``
#: byte-for-byte. ``EIP712Domain`` is supplied by ``sign_typed_data`` from the
#: domain dict, so it is intentionally absent here.
PRINT_TYPES = {
    "Print": [
        {"name": "indexId", "type": "bytes32"},
        {"name": "value", "type": "uint256"},
        {"name": "ciLo", "type": "uint256"},
        {"name": "ciHi", "type": "uint256"},
        {"name": "attackCostPerBp", "type": "uint256"},
        {"name": "timestamp", "type": "uint64"},
    ]
}


def print_domain(chain_id: int, oracle_address: str) -> dict:
    """The EIP-712 domain the oracle constructs in its constructor."""
    from web3 import Web3

    return {
        "name": "ACR Oracle",
        "version": "1",
        "chainId": int(chain_id),
        "verifyingContract": Web3.to_checksum_address(oracle_address),
    }


def sign_print(
    payload: PostPayload, chain_id: int, oracle_address: str, private_key: str
) -> tuple[int, bytes, bytes]:
    """EIP-712-sign a print. Returns ``(v, r, s)`` ready for ``postPrint``."""
    from eth_account import Account

    message = {
        "indexId": payload.index_id,
        "value": payload.value,
        "ciLo": payload.ci_lo,
        "ciHi": payload.ci_hi,
        "attackCostPerBp": payload.attack_cost_per_bp,
        "timestamp": payload.timestamp,
    }
    signed = Account.sign_typed_data(
        private_key,
        domain_data=print_domain(chain_id, oracle_address),
        message_types=PRINT_TYPES,
        message_data=message,
    )
    return int(signed.v), int(signed.r).to_bytes(32, "big"), int(signed.s).to_bytes(32, "big")


# ABI fragment: postPrint (signed) + read-back + staleness views.
_PRINT_TUPLE = {
    "type": "tuple",
    "name": "",
    "components": [
        {"name": "value", "type": "uint256"},
        {"name": "ciLo", "type": "uint256"},
        {"name": "ciHi", "type": "uint256"},
        {"name": "attackCostPerBp", "type": "uint256"},
        {"name": "timestamp", "type": "uint64"},
        {"name": "postedAt", "type": "uint64"},
        {"name": "exists", "type": "bool"},
    ],
}
ORACLE_ABI = [
    {
        "type": "function",
        "name": "postPrint",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "indexId", "type": "bytes32"},
            {"name": "value", "type": "uint256"},
            {"name": "ciLo", "type": "uint256"},
            {"name": "ciHi", "type": "uint256"},
            {"name": "attackCostPerBp", "type": "uint256"},
            {"name": "timestamp", "type": "uint64"},
            {"name": "v", "type": "uint8"},
            {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "printDigest",
        "stateMutability": "view",
        "inputs": [
            {"name": "indexId", "type": "bytes32"},
            {"name": "value", "type": "uint256"},
            {"name": "ciLo", "type": "uint256"},
            {"name": "ciHi", "type": "uint256"},
            {"name": "attackCostPerBp", "type": "uint256"},
            {"name": "timestamp", "type": "uint64"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "latestPrint",
        "stateMutability": "view",
        "inputs": [{"name": "indexId", "type": "bytes32"}],
        "outputs": [_PRINT_TUPLE],
    },
    {
        "type": "function",
        "name": "latestValue",
        "stateMutability": "view",
        "inputs": [{"name": "indexId", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "latestPrintWithAge",
        "stateMutability": "view",
        "inputs": [{"name": "indexId", "type": "bytes32"}],
        "outputs": [_PRINT_TUPLE, {"name": "age", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "isStale",
        "stateMutability": "view",
        "inputs": [
            {"name": "indexId", "type": "bytes32"},
            {"name": "maxAge", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


class OracleClient:
    def __init__(
        self,
        rpc_url: str | None = None,
        oracle_address: str | None = None,
        private_key: str | None = None,
        signer: Signer | None = None,
    ) -> None:
        settings = get_settings()
        self.rpc_url = rpc_url or settings.arc_rpc_url
        self.oracle_address = oracle_address or (settings.oracle_address or None)
        # Back-compat: a passed/settings raw key builds a LocalKeySigner; else a
        # Circle wallet signer if creds are configured; else None (offline).
        self.private_key = private_key or (settings.poster_private_key or None)
        self.signer = signer or build_signer(settings, private_key=self.private_key)
        self._w3 = None
        #: Receipt of the most recent successful ``post`` ({tx, block, gas_used});
        #: None while offline — the poster reads this for on-chain provenance.
        self.last_receipt: dict | None = None

    def _connect(self):
        if self._w3 is not None:
            return self._w3
        try:
            from web3 import Web3

            self._w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 5}))
        except Exception as exc:  # pragma: no cover - env dependent
            log.warning("OracleClient: web3 unavailable (%s)", exc)
            self._w3 = None
        return self._w3

    def can_post(self) -> bool:
        w3 = self._connect()
        if w3 is None or not self.oracle_address or self.signer is None:
            return False
        try:
            return bool(w3.is_connected())
        except Exception:  # pragma: no cover - env dependent
            return False

    def _contract(self):  # pragma: no cover - requires live chain
        w3 = self._connect()
        return w3.eth.contract(
            address=w3.to_checksum_address(self.oracle_address), abi=ORACLE_ABI
        )

    def post(self, p: ACRPrint, wait: bool = True) -> str | None:
        """Post a print; returns the tx hash hex, or None if offline.

        Offline is the expected path in local demos — the payload is still
        constructed and logged so behavior is observable without a chain.
        """
        payload = PostPayload.from_print(p)
        if not self.can_post():
            log.info("OracleClient offline: would post %s -> %s", p.index_id, payload.as_args())
            self.last_receipt = None
            return None
        w3 = self._connect()  # pragma: no cover - requires live chain
        contract = self._contract()
        # EIP-712-sign the print via the signer (raw key or Circle custody); the
        # contract verifies the *signer*, not the sender, so any relayer submits.
        chain_id = w3.eth.chain_id
        message = {
            "indexId": payload.index_id,
            "value": payload.value,
            "ciLo": payload.ci_lo,
            "ciHi": payload.ci_hi,
            "attackCostPerBp": payload.attack_cost_per_bp,
            "timestamp": payload.timestamp,
        }
        v, r, s = self.signer.sign_typed_data(
            print_domain(chain_id, self.oracle_address), PRINT_TYPES, message, "Print"
        )
        # Build with the signer's address as `from`; "gas" is omitted so web3
        # estimates it (the first post per index does ~12 cold SSTOREs).
        tx = contract.functions.postPrint(*payload.signed_args(v, r, s)).build_transaction(
            {
                "from": self.signer.address,
                "nonce": w3.eth.get_transaction_count(self.signer.address),
                "chainId": chain_id,
            }
        )
        tx_hash = self.signer.send_transaction(w3, tx)
        if wait:
            rcpt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
            if rcpt.status != 1:
                raise RuntimeError(f"postPrint reverted for {p.index_id} (tx {tx_hash})")
            # None-safe receipt provenance (some RPCs omit fields on early reads).
            block = rcpt.get("blockNumber")
            gas = rcpt.get("gasUsed")
            self.last_receipt = {
                "tx": str(tx_hash),
                "block": int(block) if block is not None else None,
                "gas_used": int(gas) if gas is not None else None,
            }
        else:
            self.last_receipt = {"tx": str(tx_hash), "block": None, "gas_used": None}
        return tx_hash

    def read_latest(self, index_id: str) -> dict | None:  # pragma: no cover - live chain
        """Read back the latest on-chain print for ``index_id`` (WAD-descaled)."""
        if self._connect() is None or not self.oracle_address:
            return None
        c = self._contract()
        idx = index_id_to_bytes32(index_id)
        try:
            v, lo, hi, bound, ts, posted_at, exists = c.functions.latestPrint(idx).call()
        except Exception:
            return None  # contract reverts "no print" when none exists yet
        if not exists:
            return None
        return {
            "index_id": index_id,
            "value": v / WAD,
            "ci_lo": lo / WAD,
            "ci_hi": hi / WAD,
            "attack_cost_per_bp": bound / USDC,
            "timestamp": ts,
            "posted_at": posted_at,
        }

    def is_stale(self, index_id: str, max_age: int) -> bool | None:  # pragma: no cover - live chain
        """True/False if the on-chain print is older than ``max_age`` seconds;
        None if offline."""
        if self._connect() is None or not self.oracle_address:
            return None
        try:
            return bool(self._contract().functions.isStale(index_id_to_bytes32(index_id), max_age).call())
        except Exception:
            return None
