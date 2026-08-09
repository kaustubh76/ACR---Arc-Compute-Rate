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
        #: The venue's whole series list, shared by the desk's exit path.
        self._series: list[dict] = []
        self._series_at = 0.0
        #: Short-TTL trade-tape cache + first-seen wall-clock per tx (so the UI can
        #: show an honest "seen Ns ago" without a per-block RPC round trip).
        self._trades: list[dict] = []
        self._trades_at = 0.0
        self._seen: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self.futures_address)

    def all_series(self, *, use_cache: bool = True) -> list[dict]:
        """Every series on the venue, settled ones included — memoized.

        The desk's exit path needs exactly the series ``read_all`` filters out
        (a reader must be able to leave a series that has expired), so it used
        to call the client directly and paid a full uncached scan every time:
        measured at 9.5s on the request path against a warm host. Sharing one
        memo means the background warm covers that path too.
        """
        if not self.configured:
            return []
        if use_cache:
            with self._lock:
                if self._series and time.monotonic() - self._series_at < FUTURES_TTL_S:
                    return [dict(s) for s in self._series]
        try:
            out = self._client.read_all_series()
        except Exception:
            return []
        with self._lock:
            self._series = out
            self._series_at = time.monotonic()
        return [dict(s) for s in out]

    def read_desk(self, index_id: str, *, all_series: list[dict] | None = None) -> dict | None:
        if not self.configured:
            return None
        try:
            return self._client.read_desk(index_id, all_series=all_series)
        except Exception:
            return None

    def read_all(self, *, use_cache: bool = True) -> dict[str, dict]:
        """Every index's live desk.

        Scans the venue's series ONCE and hands the list to each index, rather
        than letting each ``read_desk`` re-scan. That scan is the expensive part
        and only one of the demo's three indices has a series, so the old shape
        paid for the whole venue three times to produce one desk — the single
        biggest contributor to a cold desk read.
        """
        if not self.configured:
            return {}
        if use_cache:
            with self._lock:
                if self._cache and time.monotonic() - self._cache_at < FUTURES_TTL_S:
                    return dict(self._cache)
        series = self.all_series(use_cache=use_cache)
        out: dict[str, dict] = {}
        for iid in ALL_INDEX_IDS:
            d = self.read_desk(iid, all_series=series)
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
    #: Raised from 30s once the tape started PAGING back several hours: that walk
    #: costs a few seconds when it misses, and /futures is the endpoint the
    #: desk's liveness is judged by. The background warm refreshes this every
    #: ACR_CHAIN_WARM_SECONDS (60), so the TTL only has to outlive that gap —
    #: and the fills themselves are at most hourly, so a 90s-old tape is not
    #: meaningfully staler than a fresh one. Ages shown in the UI come from a
    #: server-side first-seen stamp, not from this read.
    _TRADES_TTL_S = 90.0

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

    def settled_rounds(self, *, use_cache: bool = True) -> list[dict]:
        """Every series that has completed its life, newest first.

        ``select_series_for_index`` deliberately hides a settled series the
        moment a live one exists on the same index — right for the tradable
        desk, and exactly wrong for proving the machinery works: the venue's
        first completed settlement would leave no visible trace anywhere but
        the explorer. This is the ledger of finished rounds, built from the
        same cached ``all_series`` scan the desks already paid for, so it
        costs no extra RPC.
        """
        if not self.configured:
            return []
        try:
            series = self.all_series(use_cache=use_cache)
        except Exception:
            return []
        done = [s for s in series if s.get("exists") and s.get("settled")]
        done.sort(key=lambda s: s.get("series_id", 0), reverse=True)
        # Exactly the fields `descale_series` decodes, and no more. Open
        # interest and trader count belong to `read_desk`'s enrichment, not to
        # this scan, and after settlement the contract has deleted every
        # position anyway — a zero OI here would describe the clearing, not
        # the round that was traded.
        return [
            {
                "series_id": s.get("series_id"),
                "index_id": s.get("index_id"),
                "settlement_price": s.get("settlement_price"),
                "expiry_ts": s.get("expiry_ts"),
                "multiplier": s.get("multiplier"),
                "maker": s.get("maker"),
            }
            for s in done
        ]

    def roster(self, *, use_cache: bool = True) -> dict:
        """The whole futures venue for the Terminal desk + tape: address, per-index
        desks, the recent trade tape, and the settled-rounds ledger."""
        if not self.configured:
            return {"venue": None, "desks": {}, "trades": [], "settled": []}
        return {
            "venue": self.futures_address,
            "desks": self.read_all(use_cache=use_cache),
            "trades": self.recent_trades(use_cache=use_cache),
            "settled": self.settled_rounds(use_cache=use_cache),
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
