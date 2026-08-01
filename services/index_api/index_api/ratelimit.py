"""A small in-process rate limiter for the public desk endpoints.

Deliberately not slowapi: this runs as a single instance on a 512MB tier with
no Redis, the behaviour needed is a fixed-window counter, and the repo already
hand-rolls this shape elsewhere (bounded x402 counters, the pruned first-seen
map in ``onchain``). Fifty testable lines beat a transitive dependency tree in
the production image.

The limiter is **bounded** — 4096 keys, least-recently-used evicted. A limiter
keyed on caller-supplied identity that grows without limit is itself the denial
of service it was added to prevent.

Single-process only. Behind more than one instance each replica keeps its own
counters, so the effective limit multiplies by the replica count; that is fine
for a single free-tier box and would need Redis if it ever stops being one.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque

MAX_KEYS = 4096


class RateLimiter:
    """Fixed-window-per-key counter. ``allow()`` records the hit it permits."""

    def __init__(self, max_keys: int = MAX_KEYS) -> None:
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()
        self._max_keys = max_keys

    def allow(self, key: str, limit: int, window_s: float, *, now: float | None = None) -> bool:
        t = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                hits = deque()
                self._hits[key] = hits
            self._hits.move_to_end(key)
            while hits and t - hits[0] >= window_s:
                hits.popleft()
            if len(hits) >= limit:
                return False
            hits.append(t)
            while len(self._hits) > self._max_keys:
                self._hits.popitem(last=False)  # evict least-recently-used
            return True


_limiter = RateLimiter()

#: Per-endpoint budgets, tightest where the money is. The faucet spends real
#: USDC and session creation makes a Circle user, so those are strict; the read
#: endpoints are memoized and cheap, so they only need a runaway guard.
DESK_BUDGETS: dict[str, tuple[int, float]] = {
    "faucet": (3, 3600.0),
    "session": (5, 3600.0),
    "challenge": (30, 3600.0),
    "wallet": (120, 3600.0),
    "limits": (120, 3600.0),
    "withdrawable": (120, 3600.0),
}


def client_key(request) -> str:
    """Best available caller identity. Render (and any sane proxy) sets
    X-Forwarded-For; the left-most hop is the original client. Falls back to the
    socket peer, which is the proxy itself when there is one — so this degrades
    to a global limit rather than to no limit."""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    client = getattr(request, "client", None)
    return getattr(client, "host", "") or "unknown"


def check(request, endpoint: str) -> None:
    """Raise HTTP 429 when this caller has spent its budget for ``endpoint``."""
    from fastapi import HTTPException

    limit, window = DESK_BUDGETS.get(endpoint, (60, 3600.0))
    if not _limiter.allow(f"{endpoint}:{client_key(request)}", limit, window):
        raise HTTPException(
            status_code=429,
            detail="the desk is busy — try again in a little while",
        )
