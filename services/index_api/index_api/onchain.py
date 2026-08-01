"""On-chain oracle reader — the API serving the *settlement-grade* print.

When the API is configured with a deployed ``ACROracle`` address
(``ACR_ORACLE_ADDRESS`` + ``ACR_ARC_RPC_URL``), it can serve the value other
contracts actually settle against — read straight from chain — alongside the
freshly-computed estimate. Fully optional: with no chain configured every method
returns ``None``/``{}`` and the API keeps serving in-process prints.
"""

from __future__ import annotations

import threading
import time

from acr_core import ALL_INDEX_IDS, get_settings
from acr_oracle_client import FuturesClient, OracleClient

#: On-chain prints only change when the poster posts (~every refresh, 30s), but
#: each read is a slow remote-RPC call. Cache read_all() so /terminal/data stays
#: fast (the human feed is polled every few seconds by many clients) instead of
#: blocking on 3 sequential eth_calls per request. TTL is set above the refresh
#: interval so the background loop's warm (read_all(use_cache=False) after each
#: post) keeps the request-path cache from ever expiring; the value stays ~fresh
#: to the last post cycle regardless.
READ_ALL_TTL_S = 90.0


class OracleReader:
    def __init__(self, rpc_url: str | None = None, oracle_address: str | None = None) -> None:
        settings = get_settings()
        self.oracle_address = oracle_address or (settings.oracle_address or None)
        self.rpc_url = rpc_url or settings.arc_rpc_url
        self._client = OracleClient(rpc_url=self.rpc_url, oracle_address=self.oracle_address)
        self._lock = threading.Lock()
        self._cache: dict[str, dict] = {}
        self._cache_at = 0.0

    @property
    def configured(self) -> bool:
        return bool(self.oracle_address)

    def read(self, index_id: str) -> dict | None:
        if not self.configured:
            return None
        try:
            return self._client.read_latest(index_id)
        except Exception:
            return None

    def read_all(self, *, use_cache: bool = True) -> dict[str, dict]:
        if not self.configured:
            return {}
        if use_cache:
            with self._lock:
                if self._cache and time.monotonic() - self._cache_at < READ_ALL_TTL_S:
                    return dict(self._cache)
        out: dict[str, dict] = {}
        for iid in ALL_INDEX_IDS:
            r = self.read(iid)
            if r is not None:
                out[iid] = r
        with self._lock:
            self._cache = out
            self._cache_at = time.monotonic()
        return out


# Lazy module singleton (not lru_cache) so the env is read when the reader is
# first built at startup — and so tests can reset it.
_reader: OracleReader | None = None


def get_reader() -> OracleReader:
    global _reader
    if _reader is None:
        _reader = OracleReader()
    return _reader


def reset_reader() -> None:
    """Drop the cached reader (tests / after changing oracle env)."""
    global _reader
    _reader = None


#: TTL for the futures desk cache — same rationale as READ_ALL_TTL_S (the human
#: feed is polled often; each desk read is several eth_calls).
FUTURES_TTL_S = 90.0


class FuturesReader:
    """Reads the on-chain ``ACRFutures`` desk (one series per index) for the
    Terminal. Mirrors :class:`OracleReader`: cached, and a graceful no-op
    (``configured is False`` → empty) when ``ACR_FUTURES_ADDRESS`` is unset."""

    def __init__(self, rpc_url: str | None = None, futures_address: str | None = None) -> None:
        settings = get_settings()
        self.futures_address = futures_address or (settings.futures_address or None)
        self.rpc_url = rpc_url or settings.arc_rpc_url
        self._client = FuturesClient(rpc_url=self.rpc_url, futures_address=self.futures_address)
        self._lock = threading.Lock()
        self._cache: dict[str, dict] = {}
        self._cache_at = 0.0
        #: Short-TTL trade-tape cache + first-seen wall-clock per tx (so the UI can
        #: show an honest "seen Ns ago" without a per-block RPC round trip).
        self._trades: list[dict] = []
        self._trades_at = 0.0
        self._seen: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self.futures_address)

    def read_desk(self, index_id: str) -> dict | None:
        if not self.configured:
            return None
        try:
            return self._client.read_desk(index_id)
        except Exception:
            return None

    def read_all(self, *, use_cache: bool = True) -> dict[str, dict]:
        if not self.configured:
            return {}
        if use_cache:
            with self._lock:
                if self._cache and time.monotonic() - self._cache_at < FUTURES_TTL_S:
                    return dict(self._cache)
        out: dict[str, dict] = {}
        for iid in ALL_INDEX_IDS:
            d = self.read_desk(iid)
            if d is not None:
                out[iid] = d
        with self._lock:
            self._cache = out
            self._cache_at = time.monotonic()
        return out

    def maker_inventory(self, *, use_cache: bool = True) -> dict[str, float]:
        """Per-index maker inventory (signed contracts) — what ``store.curve()``
        skews the term structure around."""
        return {
            iid: float(d.get("maker_inventory", 0.0))
            for iid, d in self.read_all(use_cache=use_cache).items()
        }

    #: The trade tape wants fresher data than the aggregate desk, but every miss
    #: costs an eth_getLogs against a throttled RPC — and that read sits on the
    #: request path of the endpoint the trading desk's liveness is judged by, so
    #: a too-eager TTL makes /futures intermittently slow enough for the
    #: terminal to fall back a tier and hide the desk. The heartbeat trades
    #: hourly; half a minute of tape staleness is invisible next to that.
    _TRADES_TTL_S = 30.0

    def recent_trades(self, *, use_cache: bool = True) -> list[dict]:
        """Recent on-chain fills (newest-first), each stamped with the wall-clock
        the server first observed its tx (``seen_at``)."""
        if not self.configured:
            return []
        if use_cache:
            with self._lock:
                if self._trades and time.monotonic() - self._trades_at < self._TRADES_TTL_S:
                    return [dict(t) for t in self._trades]
        try:
            raw = self._client.recent_trades()
        except Exception:
            raw = []
        now = time.time()
        stamped: list[dict] = []
        for t in raw:
            seen = self._seen.setdefault(t["tx"], now)
            stamped.append({**t, "seen_at": seen})
        with self._lock:
            self._trades = stamped
            self._trades_at = time.monotonic()
            # Bound the first-seen map to the txs still in the window.
            live_txs = {t["tx"] for t in stamped}
            self._seen = {tx: s for tx, s in self._seen.items() if tx in live_txs}
        return [dict(t) for t in stamped]

    def roster(self, *, use_cache: bool = True) -> dict:
        """The whole futures venue for the Terminal desk + tape: address, per-index
        desks, and the recent trade tape."""
        if not self.configured:
            return {"venue": None, "desks": {}, "trades": []}
        return {
            "venue": self.futures_address,
            "desks": self.read_all(use_cache=use_cache),
            "trades": self.recent_trades(use_cache=use_cache),
        }


_futures: FuturesReader | None = None


def get_futures() -> FuturesReader:
    global _futures
    if _futures is None:
        _futures = FuturesReader()
    return _futures


def reset_futures() -> None:
    """Drop the cached futures reader (tests / after changing futures env)."""
    global _futures
    _futures = None
