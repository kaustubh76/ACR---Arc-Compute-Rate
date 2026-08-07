"""A small in-process rate limiter for the public desk endpoints.

Deliberately not slowapi: this runs as a single instance on a 512MB tier with
no Redis, the behaviour needed is a fixed-window counter, and the repo already
hand-rolls this shape elsewhere (bounded x402 counters, the pruned first-seen
map in ``onchain``). Fifty testable lines beat a transitive dependency tree in
the production image.

The limiter is **bounded** — 4096 keys, least-recently-used evicted. A limiter
keyed on caller-supplied identity that grows without limit is itself the denial
of service it was added to prevent.

**Two buckets per request, and the split is the whole point.** The desk is
reached through a server-side Next.js proxy on Vercel, so every reader in the
world arrives from the same handful of edge IPs. An IP-keyed limit is therefore
not a per-person limit at all — it is a global one, and at the old budgets the
sixth visitor in an hour was told "the desk is busy" by a desk that was idle.
So:

* the **identity** bucket is the per-person limit — keyed on who the caller
  actually is (their desk user id, their session token, their wallet address);
* the **host** bucket is only a runaway guard on one talkative source, sized
  for a shared proxy rather than a person.

Single-process only. Behind more than one instance each replica keeps its own
counters, so the effective limit multiplies by the replica count; that is fine
for a single free-tier box and would need Redis if it ever stops being one.
"""

from __future__ import annotations

import hashlib
import ipaddress
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

#: Per-IDENTITY budgets — the real per-person limit, tightest where the money is.
#: The faucet spends real USDC and session creation makes a Circle user, so those
#: stay strict; the read endpoints are memoized and cheap, so they only need a
#: runaway guard. ``session`` allows more than one because a page reload re-opens
#: the session to refresh the 60-minute token, and a reader reloading a slow page
#: must not lock themselves out of the demo.
DESK_BUDGETS: dict[str, tuple[int, float]] = {
    "faucet": (3, 3600.0),
    "session": (12, 3600.0),
    "challenge": (40, 3600.0),
    "wallet": (60, 3600.0),
    "limits": (240, 3600.0),
    "withdrawable": (240, 3600.0),
}

#: Per-HOST budgets — one shared proxy carries every reader, so these are sized
#: for a crowd, not a person. Raising them is safe because the IP counter was
#: never what stood between the custody wallet and a drain: the faucet's actual
#: protections are :meth:`desk.FaucetLedger.claim` (one drip per address, ever),
#: ``FAUCET_GLOBAL_CAP`` = 25, and the ``FAUCET_RESERVE_USDC`` floor checked in
#: ``drip_stake``. Note the faucet ceiling sits ABOVE that global cap on purpose
#: — the ledger should be the thing that says no, because it says no honestly
#: ("the faucet is out of funds") instead of "try again later".
HOST_BUDGETS: dict[str, tuple[int, float]] = {
    "faucet": (40, 3600.0),
    "session": (60, 3600.0),
    "challenge": (300, 3600.0),
    "wallet": (600, 3600.0),
    "limits": (2400, 3600.0),
    "withdrawable": (2400, 3600.0),
}


def _is_internal(host: str) -> bool:
    """A private, loopback or link-local address — i.e. our own infrastructure
    rather than anything that identifies a source on the internet."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved


def client_key(request) -> str:
    """The source host, chosen so a caller cannot mint themselves a fresh bucket.

    ``X-Forwarded-For`` is "client, proxy1, proxy2, …": each hop APPENDS the peer
    it saw, so entries on the **right** were observed by our own infrastructure
    and the left-most is whatever the caller typed. This host is public — anyone
    can POST to it directly — so a guard that trusts the left-most entry is
    bypassed by rotating a header, which is exactly the abuse it exists to stop.

    Walk from the right and take the first hop that is not our own private
    plumbing: a platform load balancer may append an internal address, and
    keying on that would collapse every source in the world onto one bucket.
    Falls back to the socket peer.

    Readers behind the Vercel proxy still share one key, because to us they
    genuinely are one host. That is why this bucket is only a ceiling —
    per-person fairness comes from the identity bucket in :func:`check`.
    """
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        hops = [h.strip() for h in fwd.split(",") if h.strip()]
        for host in reversed(hops):
            if not _is_internal(host):
                return host
        if hops:
            return hops[-1]  # all internal — better than pretending we know
    client = getattr(request, "client", None)
    return getattr(client, "host", "") or "unknown"


def session_ident(user_token: str) -> str:
    """A stable, non-reversible handle for a desk session.

    Used instead of re-resolving the wallet address at Circle: that would add a
    network round trip to every rate-limit check, on endpoints whose whole
    problem is already latency. A token is scarce in its own right — minting a
    new one costs a ``/desk/session`` call, which is itself limited — so it is a
    sound identity, and hashing keeps a bearer credential out of the key table.
    """
    return hashlib.sha256(user_token.encode("utf-8")).hexdigest()[:32]


def check(request, endpoint: str, ident: str | None = None) -> None:
    """Raise HTTP 429 when this caller has spent a budget for ``endpoint``.

    ``ident`` is who the caller is — a desk user id, a hashed session token, or a
    wallet address. Pass it whenever it is already in hand; the per-person limit
    depends on it, and without it a caller is only held to the loose host
    ceiling. Never derive it from a header a caller controls.
    """
    from fastapi import HTTPException

    if ident:
        limit, window = DESK_BUDGETS.get(endpoint, (60, 3600.0))
        if not _limiter.allow(f"{endpoint}:id:{ident.lower()}", limit, window):
            raise HTTPException(
                status_code=429,
                detail="you've used this part of the desk a lot in the last hour "
                "— give it a few minutes",
            )

    limit, window = HOST_BUDGETS.get(endpoint, (600, 3600.0))
    if not _limiter.allow(f"{endpoint}:host:{client_key(request)}", limit, window):
        raise HTTPException(
            status_code=429,
            detail="the desk is busy, so try again in a little while",
        )
