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
from acr_oracle_client import OracleClient

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
