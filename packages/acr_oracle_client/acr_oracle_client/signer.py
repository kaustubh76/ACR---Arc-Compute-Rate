"""Signer abstraction — EIP-712-sign typed data and submit transactions.

Two implementations, selected by config presence:

  * ``LocalKeySigner`` — a raw in-process EOA (``eth_account``). The default;
    byte-identical to the pre-Circle behavior, so the anvil round-trip is
    unchanged.
  * ``CircleWalletSigner`` — a Circle Developer-Controlled wallet. The signing
    key stays in Circle custody: it EIP-712-signs the ``Print`` (the oracle
    verifies the *signer*, not ``msg.sender``) and submits via Circle
    contract-execution (paying Arc USDC gas). The Circle SDK is imported lazily,
    only when no client is injected, so hermetic tests never require it.

The public seam is the ``Signer`` protocol; ``OracleClient``/``RegistryClient``
depend on it instead of a raw key. ``build_signer`` picks the impl from settings.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Protocol, runtime_checkable

log = logging.getLogger("acr_oracle_client.signer")


@runtime_checkable
class Signer(Protocol):
    @property
    def address(self) -> str: ...

    def sign_typed_data(
        self, domain: dict, types: dict, message: dict, primary_type: str
    ) -> tuple[int, bytes, bytes]:
        """EIP-712-sign ``message`` and return ``(v, r, s)``."""
        ...

    def send_transaction(self, w3, tx: dict) -> str:
        """Submit a built transaction dict (``to``/``data``/…); return tx-hash hex."""
        ...


def split_signature(sig: bytes) -> tuple[int, bytes, bytes]:
    """Split a 65-byte ``r‖s‖v`` signature into ``(v, r, s)``; normalize v to 27/28."""
    if len(sig) != 65:
        raise ValueError(f"expected a 65-byte signature, got {len(sig)}")
    r, s, v = sig[0:32], sig[32:64], sig[64]
    if v < 27:
        v += 27
    return v, r, s


def full_eip712_json(domain: dict, types: dict, primary_type: str, message: dict) -> dict:
    """Assemble a *complete* EIP-712 typed-data document.

    Circle's typed-data signing wants the full JSON (the ``EIP712Domain`` type and
    ``primaryType`` included), unlike ``eth_account``'s partial-dict form. For JSON
    transport: ``bytes`` fields are hex-encoded, and integers are encoded as
    **strings** — a raw JSON number loses precision above 2^53, which would corrupt
    the hash for WAD-scaled (1e18) print values and make the signature invalid.
    """
    domain_type = [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ]

    def _enc(v):
        if isinstance(v, (bytes, bytearray)):
            return "0x" + bytes(v).hex()
        if isinstance(v, int) and not isinstance(v, bool):
            return str(v)  # uint as string — JSON numbers lose precision > 2^53
        return v

    return {
        "types": {"EIP712Domain": domain_type, **types},
        "domain": domain,
        "primaryType": primary_type,
        "message": {k: _enc(v) for k, v in message.items()},
    }


class LocalKeySigner:
    """Raw EOA signer — the default, byte-identical to the pre-Circle path."""

    def __init__(self, private_key: str) -> None:
        from eth_account import Account

        self._acct = Account.from_key(private_key)

    @property
    def address(self) -> str:
        return self._acct.address

    def sign_typed_data(self, domain, types, message, primary_type):
        from eth_account import Account

        signed = Account.sign_typed_data(
            self._acct.key, domain_data=domain, message_types=types, message_data=message
        )
        return int(signed.v), int(signed.r).to_bytes(32, "big"), int(signed.s).to_bytes(32, "big")

    def send_transaction(self, w3, tx: dict) -> str:  # pragma: no cover - requires live chain
        signed = self._acct.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        return w3.to_hex(w3.eth.send_raw_transaction(raw))  # 0x-prefixed hash


@runtime_checkable
class CircleClient(Protocol):
    """The minimal surface ``CircleWalletSigner`` needs — stable and fully mockable.

    The real SDK is wrapped by ``_RealCircleClient`` (the one place that touches
    the uncertain Circle method names). Tests inject a fake implementing this.
    """

    def wallet_address(self, wallet_id: str) -> str: ...
    def sign_typed_data(self, wallet_id: str, typed_data_json: str) -> str: ...  # 65-byte hex sig
    def contract_execution(
        self, wallet_id: str, contract_address: str, call_data: str, idempotency_key: str
    ) -> str: ...  # on-chain tx hash


class CircleWalletSigner:
    """Signer backed by a Circle Developer-Controlled wallet (custody signing)."""

    def __init__(
        self,
        *,
        wallet_id: str,
        api_key: str = "",
        entity_secret: str = "",
        base_url: str | None = None,
        client: CircleClient | None = None,
    ) -> None:
        self.wallet_id = wallet_id
        self._api_key = api_key
        self._entity_secret = entity_secret
        self._base_url = base_url
        self._client = client
        self._address: str | None = None

    def _get_client(self) -> CircleClient:
        if self._client is None:  # pragma: no cover - requires the Circle SDK + creds
            self._client = _RealCircleClient(
                api_key=self._api_key, entity_secret=self._entity_secret, base_url=self._base_url
            )
        return self._client

    @property
    def address(self) -> str:
        if self._address is None:
            self._address = self._get_client().wallet_address(self.wallet_id)
        return self._address

    def sign_typed_data(self, domain, types, message, primary_type):
        doc = full_eip712_json(domain, types, primary_type, message)
        sig_hex = self._get_client().sign_typed_data(self.wallet_id, json.dumps(doc))
        sig = bytes.fromhex(sig_hex[2:] if sig_hex.startswith("0x") else sig_hex)
        return split_signature(sig)

    def send_transaction(self, w3, tx: dict) -> str:
        data = tx["data"]
        call_data = data if isinstance(data, str) else "0x" + bytes(data).hex()
        return self._get_client().contract_execution(
            self.wallet_id, tx["to"], call_data, str(uuid.uuid4())
        )


class _RealCircleClient:  # pragma: no cover - requires the Circle SDK + live creds
    """Adapter mapping ``CircleClient`` onto the circle-developer-controlled-wallets
    SDK (verified against v9.6.0). Kept isolated so an SDK bump is a one-file
    change. In 9.6.0 the operations live on typed Api classes (not the client),
    and every write carries a fresh per-call ``entity_secret_ciphertext``.
    """

    def __init__(self, api_key: str, entity_secret: str, base_url: str | None = None) -> None:
        # Lazy import so the SDK is only required on the live path.
        from circle.web3 import developer_controlled_wallets as dcw  # type: ignore
        from circle.web3 import utils  # type: ignore

        self._api_key = api_key
        self._entity_secret = entity_secret
        self._utils = utils
        self._dcw = dcw
        client = utils.init_developer_controlled_wallets_client(
            api_key=api_key, entity_secret=entity_secret
        )
        self._wallets = dcw.WalletsApi(client)
        self._signing = dcw.SigningApi(client)
        self._transactions = dcw.TransactionsApi(client)

    def _ciphertext(self) -> str:
        # Each developer-controlled write needs a fresh RSA ciphertext of the secret.
        return self._utils.generate_entity_secret_ciphertext(self._api_key, self._entity_secret)

    def wallet_address(self, wallet_id: str) -> str:
        from eth_utils import to_checksum_address

        # Circle returns lowercase; web3's tx `from` requires a checksum address.
        return to_checksum_address(self._wallets.get_wallet(id=wallet_id).data.wallet.address)

    def sign_typed_data(self, wallet_id: str, typed_data_json: str) -> str:
        resp = self._signing.sign_typed_data(
            self._dcw.SignTypedDataRequest(
                wallet_id=wallet_id,
                data=typed_data_json,
                entity_secret_ciphertext=self._ciphertext(),
            )
        )
        return resp.data.signature

    def contract_execution(
        self, wallet_id: str, contract_address: str, call_data: str, idempotency_key: str
    ) -> str:
        resp = self._transactions.create_developer_transaction_contract_execution(
            self._dcw.CreateContractExecutionTransactionForDeveloperRequest(
                wallet_id=wallet_id,
                contract_address=contract_address,
                call_data=call_data,
                fee_level="MEDIUM",
                entity_secret_ciphertext=self._ciphertext(),
                idempotency_key=idempotency_key,
            )
        )
        return self._poll_tx_hash(resp.data.id)

    def _poll_tx_hash(self, tx_id: str) -> str:
        # Poll GET /transactions/{id} until CONFIRMED and return the on-chain hash.
        import time

        for _ in range(60):
            tx = self._transactions.get_transaction(id=tx_id).data.transaction
            txhash = getattr(tx, "tx_hash", None) or getattr(tx, "txHash", None)
            if tx.state in ("CONFIRMED", "COMPLETE") and txhash:
                return txhash
            if tx.state == "FAILED":
                raise RuntimeError(f"Circle tx {tx_id} failed")
            time.sleep(2)
        raise TimeoutError(f"Circle tx {tx_id} not confirmed in time")


def build_signer(settings=None, private_key: str | None = None) -> Signer | None:
    """Pick a signer from config: an explicit/settings raw key (dev) wins; else a
    Circle wallet (prod) if creds are present; else ``None`` (offline)."""
    from acr_core import get_settings

    settings = settings or get_settings()
    key = private_key or (settings.poster_private_key or None)
    if key and not key.lstrip().startswith("#"):
        return LocalKeySigner(key)
    api_key = (settings.circle_api_key or "").strip()
    wallet_id = (settings.circle_wallet_id or "").strip()
    # Only pick the Circle wallet if the creds look real (guards a malformed
    # .env from silently selecting the live signer — fail safe to offline).
    if api_key and wallet_id and not api_key.startswith("#") and not wallet_id.startswith("#"):
        return CircleWalletSigner(
            wallet_id=wallet_id,
            api_key=api_key,
            entity_secret=settings.circle_entity_secret,
            base_url=settings.circle_base_url,
        )
    return None
