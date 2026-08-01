"""Read/write the on-chain ``ACRFutures`` contract.

The Terminal desk surfaces the live futures market — the maker's inventory,
mark-to-oracle PnL, and settlement — read straight from chain. This client
mirrors :class:`OracleClient`: lazy web3, graceful offline (every read returns
``None``/``[]`` with no chain configured), and build-sign-send writes for the
demo maker/taker loop. Prices are WAD (1e18); collateral/PnL are USDC-6 (1e6).
"""

from __future__ import annotations

import logging
import time

from acr_core import get_settings

from .client import USDC, WAD, index_id_to_bytes32
from .signer import Signer, build_signer

log = logging.getLogger("acr_oracle_client")


def _rpc_retry(fn, *args, tries: int = 5, base: float = 1.5, **kwargs):
    """Call an RPC-backed function, retrying the public Arc RPC's 429s with
    linear backoff. The free-tier Arc endpoint throttles hard; a transient 429
    must not silently degrade a desk read to 'empty' (which would show a flat
    book when there is really an open one)."""
    last: Exception | None = None
    for i in range(tries):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — inspect the message, then re-raise
            msg = str(exc)
            if ("429" in msg or "Too Many Requests" in msg) and i < tries - 1:
                last = exc
                time.sleep(base * (i + 1))
                continue
            raise
    if last:  # pragma: no cover - loop always returns or raises above
        raise last


def _get_traded_logs(w3, contract, from_block: int, to_block: int):  # pragma: no cover - live chain
    """Raw topic-filtered ``eth_getLogs`` with EXPLICIT numeric bounds — the Arc
    RPC answers 413 Payload Too Large when ``toBlock`` is the string "latest"
    on a wide range (which is what web3's ``event.get_logs`` sends), but
    accepts the same range with a number. Decoded through the contract event
    so the args come back typed."""
    sig = w3.keccak(text="Traded(uint256,address,int256,uint256)").hex()
    topic0 = sig if sig.startswith("0x") else "0x" + sig
    raw = w3.eth.get_logs({
        "address": contract.address,
        "fromBlock": from_block,
        "toBlock": to_block,
        "topics": [topic0],
    })
    return [contract.events.Traded().process_log(log) for log in raw]


def bytes32_to_index_id(raw: bytes) -> str:
    """Decode a right-null-padded ``bytes32`` index id back to its string."""
    if isinstance(raw, str):  # some providers hand back hex
        raw = bytes.fromhex(raw[2:] if raw.startswith("0x") else raw)
    return raw.rstrip(b"\x00").decode("utf-8", "ignore")


def descale_series(series_id: int, t: tuple) -> dict:
    """Decode a ``getSeries`` tuple to a plain dict (human units)."""
    index_id, expiry_ts, multiplier, maker, exists, settled, settlement_price = t
    return {
        "series_id": series_id,
        "index_id": bytes32_to_index_id(index_id),
        "expiry_ts": int(expiry_ts),
        "multiplier": int(multiplier),
        "maker": maker,
        "exists": bool(exists),
        "settled": bool(settled),
        "settlement_price": settlement_price / WAD if settlement_price else 0.0,
    }


def descale_position(t: tuple, multiplier: int) -> dict:
    """Decode a ``positionOf`` tuple. ``realized_pnl_usdc`` applies the series
    multiplier to the WAD value·contracts the contract stores."""
    contracts, avg_price, realized_pnl = t
    return {
        "contracts": contracts / WAD,
        "avg_price": avg_price / WAD,
        "realized_pnl_usdc": (realized_pnl / WAD) * multiplier,
    }


def select_series_for_index(series: list[dict], index_id: str) -> dict | None:
    """Pick the series to show for an index: the latest un-settled one, else the
    latest settled one (so a just-expired series still renders until replaced)."""
    matching = [s for s in series if s["index_id"] == index_id and s["exists"]]
    if not matching:
        return None
    live = [s for s in matching if not s["settled"]]
    pool = live or matching
    return max(pool, key=lambda s: s["series_id"])


# ABI fragment: the reads the desk needs + the writes the demo loop uses.
_SERIES_TUPLE = {
    "type": "tuple",
    "name": "",
    "components": [
        {"name": "indexId", "type": "bytes32"},
        {"name": "expiryTs", "type": "uint64"},
        {"name": "multiplier", "type": "uint256"},
        {"name": "maker", "type": "address"},
        {"name": "exists", "type": "bool"},
        {"name": "settled", "type": "bool"},
        {"name": "settlementPrice", "type": "uint256"},
    ],
}
_POSITION_TUPLE = {
    "type": "tuple",
    "name": "",
    "components": [
        {"name": "contracts", "type": "int256"},
        {"name": "avgPrice", "type": "int256"},
        {"name": "realizedPnl", "type": "int256"},
    ],
}
FUTURES_ABI = [
    {"type": "function", "name": "seriesCount", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "getSeries", "stateMutability": "view",
     "inputs": [{"name": "seriesId", "type": "uint256"}], "outputs": [_SERIES_TUPLE]},
    {"type": "function", "name": "positionOf", "stateMutability": "view",
     "inputs": [{"name": "seriesId", "type": "uint256"}, {"name": "trader", "type": "address"}],
     "outputs": [_POSITION_TUPLE]},
    {"type": "function", "name": "unrealizedPnl", "stateMutability": "view",
     "inputs": [{"name": "seriesId", "type": "uint256"}, {"name": "trader", "type": "address"}],
     "outputs": [{"name": "", "type": "int256"}]},
    {"type": "function", "name": "collateral", "stateMutability": "view",
     "inputs": [{"name": "", "type": "uint256"}, {"name": "", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "traderCount", "stateMutability": "view",
     "inputs": [{"name": "seriesId", "type": "uint256"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "traderAt", "stateMutability": "view",
     "inputs": [{"name": "seriesId", "type": "uint256"}, {"name": "i", "type": "uint256"}],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "openSeries", "stateMutability": "nonpayable",
     "inputs": [{"name": "indexId", "type": "bytes32"}, {"name": "expiryTs", "type": "uint64"},
                {"name": "multiplier", "type": "uint256"}, {"name": "maker", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "postCollateral", "stateMutability": "nonpayable",
     "inputs": [{"name": "seriesId", "type": "uint256"}, {"name": "amount", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "trade", "stateMutability": "nonpayable",
     "inputs": [{"name": "seriesId", "type": "uint256"}, {"name": "qty", "type": "int256"}], "outputs": []},
    {"type": "function", "name": "withdrawCollateral", "stateMutability": "nonpayable",
     "inputs": [{"name": "seriesId", "type": "uint256"}, {"name": "amount", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "settle", "stateMutability": "nonpayable",
     "inputs": [{"name": "seriesId", "type": "uint256"}], "outputs": []},
    {"type": "event", "name": "Traded", "anonymous": False, "inputs": [
        {"name": "seriesId", "type": "uint256", "indexed": True},
        {"name": "taker", "type": "address", "indexed": True},
        {"name": "qty", "type": "int256", "indexed": False},
        {"name": "mark", "type": "uint256", "indexed": False}]},
    # The collateral round trip and the settlement itself — evidence tooling
    # reads these, and without them every caller has to re-declare the fragment.
    {"type": "event", "name": "CollateralPosted", "anonymous": False, "inputs": [
        {"name": "seriesId", "type": "uint256", "indexed": True},
        {"name": "trader", "type": "address", "indexed": True},
        {"name": "amount", "type": "uint256", "indexed": False}]},
    {"type": "event", "name": "CollateralWithdrawn", "anonymous": False, "inputs": [
        {"name": "seriesId", "type": "uint256", "indexed": True},
        {"name": "trader", "type": "address", "indexed": True},
        {"name": "amount", "type": "uint256", "indexed": False}]},
    {"type": "event", "name": "Settled", "anonymous": False, "inputs": [
        {"name": "seriesId", "type": "uint256", "indexed": True},
        {"name": "settlementPrice", "type": "uint256", "indexed": False},
        {"name": "participants", "type": "uint256", "indexed": False}]},
]


class FuturesClient:
    def __init__(
        self,
        rpc_url: str | None = None,
        futures_address: str | None = None,
        private_key: str | None = None,
        signer: Signer | None = None,
    ) -> None:
        settings = get_settings()
        self.rpc_url = rpc_url or settings.arc_rpc_url
        self.futures_address = futures_address or (settings.futures_address or None)
        self.private_key = private_key or (settings.poster_private_key or None)
        self.signer = signer or build_signer(settings, private_key=self.private_key)
        self._w3 = None

    @property
    def configured(self) -> bool:
        return bool(self.futures_address)

    def _connect(self):
        if self._w3 is not None:
            return self._w3
        try:
            from web3 import Web3

            self._w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 5}))
        except Exception as exc:  # pragma: no cover - env dependent
            log.warning("FuturesClient: web3 unavailable (%s)", exc)
            self._w3 = None
        return self._w3

    def _contract(self):  # pragma: no cover - requires live chain
        w3 = self._connect()
        return w3.eth.contract(
            address=w3.to_checksum_address(self.futures_address), abi=FUTURES_ABI
        )

    def read_all_series(self) -> list[dict]:  # pragma: no cover - live chain
        """All series as dicts (small N — one per index in the demo)."""
        if self._connect() is None or not self.configured:
            return []
        try:
            c = self._contract()
            n = int(_rpc_retry(c.functions.seriesCount().call))
            return [
                descale_series(i, tuple(_rpc_retry(c.functions.getSeries(i).call)))
                for i in range(n)
            ]
        except Exception:
            return []

    def read_desk(self, index_id: str) -> dict | None:  # pragma: no cover - live chain
        """The live desk for one index: series + maker inventory + PnL, or None
        when nothing is configured / no series exists for the index yet."""
        if self._connect() is None or not self.configured:
            return None
        try:
            series = select_series_for_index(self.read_all_series(), index_id)
            if series is None:
                return None
            c = self._contract()
            sid, maker, mult = series["series_id"], series["maker"], series["multiplier"]
            pos = descale_position(tuple(_rpc_retry(c.functions.positionOf(sid, maker).call)), mult)
            upnl = int(_rpc_retry(c.functions.unrealizedPnl(sid, maker).call)) / USDC
            traders = int(_rpc_retry(c.functions.traderCount(sid).call))
            return {
                **series,
                "maker_inventory": pos["contracts"],
                "maker_avg_price": pos["avg_price"],
                "maker_realized_usdc": pos["realized_pnl_usdc"],
                "maker_unrealized_usdc": upnl,
                "open_interest": abs(pos["contracts"]),
                "trader_count": traders,
            }
        except Exception:
            return None

    def position_of(self, series_id: int, trader: str) -> dict | None:  # pragma: no cover - live chain
        """A specific trader's position: ``{contracts, avg_price}`` (WAD-descaled,
        multiplier-independent). None if unconfigured/offline. Used by the
        maker/taker loop to read its own inventory (not the maker mirror)."""
        if self._connect() is None or not self.configured:
            return None
        try:
            c = self._contract()
            raw = tuple(_rpc_retry(c.functions.positionOf(int(series_id), trader).call))
            contracts, avg_price, _realized = raw
            return {"contracts": contracts / WAD, "avg_price": avg_price / WAD}
        except Exception:
            return None

    def collateral_of(self, series_id: int, trader: str) -> float | None:  # pragma: no cover - live chain
        """A trader's posted collateral in USDC. None if unconfigured/offline."""
        if self._connect() is None or not self.configured:
            return None
        try:
            c = self._contract()
            return int(_rpc_retry(c.functions.collateral(int(series_id), trader).call)) / USDC
        except Exception:
            return None

    def collateral_units_of(self, series_id: int, trader: str) -> int | None:  # pragma: no cover - live chain
        """The same balance in RAW USDC-6 units. A withdrawal has to name an
        exact integer to drain an account to zero — going through the float in
        :meth:`collateral_of` leaves a micro-USDC of dust behind."""
        if self._connect() is None or not self.configured:
            return None
        try:
            c = self._contract()
            return int(_rpc_retry(c.functions.collateral(int(series_id), trader).call))
        except Exception:
            return None

    def recent_trades(self, lookback_blocks: int = 10000, limit: int = 25) -> list[dict]:  # pragma: no cover - live chain
        """Recent on-chain fills from the ``Traded`` event, newest-first — the
        live trade tape. One bounded ``eth_getLogs`` (cheap even on the throttled
        Arc RPC); falls back to a narrower window if the node caps the range.
        10k blocks ≈ 85 min at Arc's ~0.5s cadence — deep enough that the tape
        still shows the hourly heartbeat's last fill."""
        if self._connect() is None or not self.configured:
            return []
        try:
            w3 = self._connect()
            c = self._contract()
            latest = int(_rpc_retry(lambda: w3.eth.block_number))
            for span in (lookback_blocks, 2500, 1000, 300):
                start = max(0, latest - span)
                try:
                    logs = _rpc_retry(lambda s=start: _get_traded_logs(w3, c, s, latest))
                    break
                except Exception:
                    logs = []
            out: list[dict] = []
            for ev in list(logs)[-limit:][::-1]:  # newest first
                a = ev["args"]
                qty = int(a["qty"]) / WAD
                out.append({
                    "series_id": int(a["seriesId"]),
                    "taker": a["taker"],
                    "qty": qty,
                    "side": "buy" if qty > 0 else "sell",
                    "mark": int(a["mark"]) / WAD,
                    "block": int(ev["blockNumber"]),
                    "tx": w3.to_hex(ev["transactionHash"]),
                })
            return out
        except Exception:
            return []

    # --- writes (demo maker/taker loop; operator-gated on a funded key) ---

    def can_write(self) -> bool:
        w3 = self._connect()
        if w3 is None or not self.configured or self.signer is None:
            return False
        try:
            return bool(w3.is_connected())
        except Exception:  # pragma: no cover - env dependent
            return False

    def _send(self, fn):  # pragma: no cover - requires live chain
        w3 = self._connect()
        tx = _rpc_retry(
            fn.build_transaction,
            {
                "from": self.signer.address,
                "nonce": w3.eth.get_transaction_count(self.signer.address),
                "chainId": w3.eth.chain_id,
            },
        )
        tx_hash = self.signer.send_transaction(w3, tx)
        # poll_latency=2s (not the 0.1s default) so the receipt wait doesn't
        # hammer the throttled Arc RPC into 429s.
        rcpt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=90, poll_latency=2.0)
        if rcpt.status != 1:
            raise RuntimeError(f"tx reverted ({tx_hash})")
        return str(tx_hash)

    def open_series(self, index_id: str, expiry_ts: int, multiplier: int, maker: str) -> str | None:  # pragma: no cover - live chain
        if not self.can_write():
            return None
        c = self._contract()
        return self._send(
            c.functions.openSeries(index_id_to_bytes32(index_id), int(expiry_ts), int(multiplier), maker)
        )

    def post_collateral(self, series_id: int, amount_usdc: float) -> str | None:  # pragma: no cover - live chain
        if not self.can_write():
            return None
        c = self._contract()
        return self._send(c.functions.postCollateral(int(series_id), int(round(amount_usdc * USDC))))

    def withdraw_collateral(self, series_id: int, amount_units: int) -> str | None:  # pragma: no cover - live chain
        """Take collateral back out, in RAW USDC-6 units (see
        :meth:`collateral_units_of`). The contract lets an unsettled account
        withdraw only down to its initial margin; a settled one is flat, so the
        whole cleared balance is free."""
        if not self.can_write():
            return None
        c = self._contract()
        return self._send(c.functions.withdrawCollateral(int(series_id), int(amount_units)))

    def trade(self, series_id: int, qty_contracts: float) -> str | None:  # pragma: no cover - live chain
        if not self.can_write():
            return None
        c = self._contract()
        return self._send(c.functions.trade(int(series_id), int(round(qty_contracts * WAD))))

    def settle(self, series_id: int) -> str | None:  # pragma: no cover - live chain
        if not self.can_write():
            return None
        return self._send(self._contract().functions.settle(int(series_id)))
