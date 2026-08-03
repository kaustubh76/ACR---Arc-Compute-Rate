"""x402-gated ACR index API (FastAPI).

Public: /health, / (service card), /onchain/{index_id} (settlement-grade print
read straight from ACROracle when an oracle is configured), /revenue
(Nanopayments dogfood metric), /x402/info, /marketplace/catalog (Bazaar-shaped
agent listings), /marketplace/receipts (settlement ledger), /terminal/data.
x402-gated (HTTP 402 unless a valid PAYMENT-SIGNATURE / X-Payment header):
    GET /prints                 all latest prints + CI + attack cost
    GET /prints/{index_id}      one index
    GET /curve/{index_id}       term structure (A-S mids by tenor)
    GET /vol/{index_id}         realized vol
    GET /seller-scores/{id}     seller reliability

Run: uv run uvicorn index_api.app:app --reload
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

from acr_core import ALL_INDEX_IDS, get_settings, spec_for
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from . import ratelimit
from .onchain import get_futures, get_reader
from .poster import OraclePoster
from .store import PrintStore
from .x402 import (
    PAY_TO,
    CircleFacilitator,
    Facilitator,
    PaymentReceipt,
    PaymentRequired,
    get_facilitator,
    price_usdc,
    require_payment,
)

log = logging.getLogger("index_api")
# Surface app INFO logs (webhooks, x402 settles, poster) under `make api`. Without
# a handler, Python's last-resort logger only prints WARNING+, so successful
# webhook events would be invisible. One handler, added once, owns the output.
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s · %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)

store = PrintStore()

# Lazy module singleton (mirrors onchain.get_reader) so payload building can
# reach the poster the background loop drives — and so tests can inject one.
_poster: OraclePoster | None = None


def get_poster() -> OraclePoster:
    global _poster
    if _poster is None:
        _poster = OraclePoster(store)
    return _poster


def set_poster(poster: OraclePoster) -> None:
    """Install a poster (the lifespan's background loop; tests inject a fake)."""
    global _poster
    _poster = poster


def reset_poster() -> None:
    """Drop the cached poster (tests / after changing oracle env)."""
    global _poster
    _poster = None


# /terminal/data payload cache. The background loop rebuilds this off the event
# loop after each warm/refresh; the request handler serves this one shared dict
# instead of running the heavy build (sim + attack_snapshot + 3 sequential RPC
# reads) per request. On the 512MB free tier, N concurrent cold requests each
# building would blow past memory and OOM-kill → restart → death-spiral; serving
# a cached dict (with a single-flight lock for the pre-warm window) keeps the
# single free instance alive. See _rebuild_terminal_cache / terminal_data.
_terminal_payload_cache: dict | None = None
_terminal_payload_lock = threading.Lock()


def _stale_indices(
    onchain: dict[str, dict], refresh_seconds: float, now: float
) -> list[str]:
    """The indices whose on-chain print is missing or older than one refresh cycle.

    Per-index, because ``OraclePoster.post_latest`` isolates each index's failure
    so one revert cannot abort the rest — which means a single index can fail on
    its own and be the only thing stale.
    """
    return [
        iid
        for iid, v in onchain.items()
        if (now - (v.get("posted_at", 0) or 0)) > refresh_seconds
    ]


def _overdue_for_startup_post(onchain: dict[str, dict], refresh_seconds: float, now: float) -> bool:
    """True when ANY on-chain print is missing or older than one refresh cycle.

    The STALEST index governs, not the freshest. It used to be the freshest, on
    the reasoning that "the timer cycle posts all indices, so a lagging one is at
    most a refresh away" — and that reasoning is wrong by a margin the contract
    cares about. Post at T, fail for one index at T+60, succeed at T+120: the gap
    is already the whole 120-minute ``MAX_SETTLE_AGE`` before any jitter, and the
    press does not run to the second.

    Measured, not theorised: on 2026-08-03 the 13:31 run posted ACR-GPU and
    ACR-INF but not ACR-DATA, and ACR-DATA went **121.0 minutes** between prints
    — past the window, so its series could not have been settled. Two healthy
    indices hid the third, which is this codebase's recurring shape: the absent
    thing looks exactly like the fine thing. `make print-gaps` reports per-index
    gaps for precisely this reason.
    """
    if not onchain:
        return True
    return bool(_stale_indices(onchain, refresh_seconds, now))


#: How often to re-read the chain into the request-path caches. This is a
#: SEPARATE cadence from ``refresh_seconds`` on purpose: that timer also posts
#: an oracle print, which spends real gas, so production runs it hourly — while
#: the read caches (``READ_ALL_TTL_S`` / ``FUTURES_TTL_S``) live 90 seconds.
#: Tying the warm to the print meant the caches were cold for ~58 minutes of
#: every hour and the next visitor paid a full sequential chain sweep on the
#: request path: a measured 55s for /desk/limits, which is past the terminal
#: proxy's budget, so the desk told a reader it was down while it was up.
#: Reading costs nothing but RPC, so warm it on its own short timer.
CHAIN_WARM_SECONDS = float(os.environ.get("ACR_CHAIN_WARM_SECONDS", "60"))


async def _rehydrate_provenance(poster) -> None:
    """Seed the poster's per-index provenance from the on-chain PricePosted log.

    A no-op once populated (``OraclePoster.rehydrate`` refuses to overwrite live
    state), which is what makes it safe to call on a timer — and it must be on a
    timer. This used to run exactly once, at startup: the least reliable moment
    in the process's life, when the RPC is busiest and a cold box is racing
    everything else it has to warm. One throttled call there and /health reports
    `poster_last_tx: null` — the product telling visitors "awaiting first live
    post" while three real posts sit on chain — until the next hourly post
    repopulates it by accident. That state was live in production.
    """
    if poster.last_posts:
        return
    try:
        n = poster.rehydrate(await asyncio.to_thread(poster.client.recent_posts))
        if n:
            log.info("re-hydrated poster provenance from %d on-chain posts", n)
    except Exception:  # pragma: no cover - defensive; the next tick retries
        log.exception("poster provenance re-hydrate failed")


#: The service's own public URL. When set, the warm loop calls it on every tick
#: so the instance never looks idle.
#:
#: THE PRESS ONLY POSTS WHILE THE PROCESS IS AWAKE. The free instance sleeps
#: after ~15 idle minutes, and the only thing waking it was a GitHub cron that
#: drops ~88% of its ticks (17 of 144 slots in a measured day). Real gaps
#: between on-chain prints came out 80 · 64 · 122 · 62 · 100 · **216** · 82 · 82
#: minutes against a contract that refuses to settle on a print older than 120 —
#: so for a couple of hours the venue could not be settled at all. The posting
#: logic was never at fault: `_background` already posts on boot when the record
#: is overdue. Nothing was waking it.
#:
#: Whether a self-request resets the platform's idle timer is an EMPIRICAL
#: question, not a guarantee — the request leaves the instance, crosses the
#: router and comes back as ordinary inbound traffic, which is the same thing
#: the external pinger provides. The proof is the gap distribution measured
#: afterwards, not this comment.
SELF_URL = os.environ.get("ACR_SELF_URL", "").rstrip("/")

#: Never retry an overdue post more often than this. Without a floor, a press
#: that is failing (a 429, a dry wallet) would be retried every warm tick.
OVERDUE_POST_COOLDOWN_S = float(os.environ.get("ACR_OVERDUE_POST_COOLDOWN_S", "600"))
_last_overdue_attempt = 0.0


async def _touch_self() -> None:
    """Knock on our own front door so the instance does not go idle.

    Fire-and-forget: this must never slow a tick or raise. If the ping fails the
    worst case is the status quo — the box sleeps and the external cron is back
    to being the only alarm clock.
    """
    if not SELF_URL:
        return
    try:
        import httpx

        # Tagged so it is identifiable in the access log. That matters: Render's
        # OWN health check hits /health every ~5s from 10.228.x.x and the
        # service still sleeps, which proves the platform does not count all
        # inbound traffic toward the idle timer. Whether a knock that egresses
        # to the public hostname and returns through the edge is counted is the
        # open question — an untagged ping would be indistinguishable from the
        # platform's own probe, and I would have no way to tell.
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.get(f"{SELF_URL}/health?src=self-heartbeat")
    except Exception:  # pragma: no cover - a failed knock is not an error
        log.debug("self-ping failed", exc_info=True)


async def _post_if_overdue(store, poster, reader, settings) -> None:
    """Post when the ON-CHAIN record is stale, wherever the refresh timer sits.

    The hourly timer is the normal path; this is the recovery one. A single
    failed post used to mean waiting a full hour for the next attempt — and an
    hour is most of the contract's 120-minute settle window. Checking against
    the chain rather than against our own timer also means a process that slept
    through its slot fixes itself on the next tick instead of on the next boot.
    """
    global _last_overdue_attempt
    if not poster.client.can_post():
        return
    now = time.time()
    if now - _last_overdue_attempt < OVERDUE_POST_COOLDOWN_S:
        return
    onchain = await asyncio.to_thread(reader.read_all)  # cached; cheap per tick
    stale = _stale_indices(onchain, settings.refresh_seconds, now) if onchain else None
    if onchain and not stale:
        return
    _last_overdue_attempt = now
    # Re-post ONLY what is stale. Posting all three costs gas for two indices
    # that are already fine, and this path can fire every cooldown while one
    # index keeps failing — `stale=None` (no on-chain record at all) still means
    # post everything, because then nothing is known to be fresh.
    log.info("on-chain print is overdue for %s — posting off-cycle", stale or "every index")
    await asyncio.to_thread(store.refresh)
    await asyncio.to_thread(poster.post_latest, set(stale) if stale else None)
    await asyncio.to_thread(reader.read_all, use_cache=False)


async def _warm_chain(stop: asyncio.Event) -> None:
    """Keep the on-chain read caches warm so no reader ever pays for a cold one,
    keep the instance awake, and republish if the press has fallen behind.

    Deliberately does NOT use ``use_cache=False`` blindly on a dead chain: every
    call is already exception-tolerant and returns the last good value, so a
    throttled Arc simply leaves the previous warm entry in place.
    """
    settings = get_settings()
    reader, futures = get_reader(), get_futures()
    # The self-ping has to run even with no chain configured — keeping the box
    # awake is not an on-chain concern.
    if not (reader.configured or futures.configured or SELF_URL):
        return
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=CHAIN_WARM_SECONDS)
        except TimeoutError:
            pass
        if stop.is_set():
            break
        try:
            # First, because it is the one that keeps everything else running.
            await _touch_self()
            if reader.configured:
                await asyncio.to_thread(reader.read_all, use_cache=False)
                # Cheap while it matters, free once it doesn't: this returns
                # immediately as soon as provenance is populated. Guard on the
                # global rather than get_poster(), which would lazily build a
                # THROWAWAY poster if this tick beat _background's set_poster()
                # — we'd hydrate an instance nothing else can see.
                if _poster is not None:
                    await _rehydrate_provenance(_poster)
                    await _post_if_overdue(store, _poster, reader, settings)
            if futures.configured:
                await asyncio.to_thread(futures.read_all, use_cache=False)
                # The tape pages back several hours over a throttled RPC, so it
                # is the most expensive read the desk serves — and it sits on
                # /futures, the endpoint the venue's liveness is judged by.
                await asyncio.to_thread(futures.recent_trades, use_cache=False)
                await _run_keeper(futures)
        except Exception:  # pragma: no cover - keep the loop alive
            log.exception("chain cache warm failed")


async def _run_keeper(futures) -> None:
    """The venue's chores, on the host that already holds the credentials.

    Isolated in its own try/except INSIDE the warm loop's, deliberately: the
    caller's handler would also catch this, but then a keeper failure would skip
    the rest of that tick. A venue that stops trading is a degraded demo; a
    press that stops printing is a dead product, because the contract will not
    settle against a stale print. The chores are never allowed to cost the press
    a beat.
    """
    from . import keeper

    if not keeper.enabled():
        return
    for name, fn in (("heartbeat", keeper.heartbeat_once), ("roll", keeper.roll_if_needed)):
        try:
            verdict = await asyncio.to_thread(fn, futures)
            if verdict:
                log.info("keeper %s: %s", name, verdict)
        except Exception:  # pragma: no cover - a chore must never cost a beat
            log.warning("keeper %s failed", name, exc_info=True)


async def _background(stop: asyncio.Event) -> None:
    """Build the store off the event loop, then refresh (and post) on a timer so
    prints evolve, realized vol becomes real, and the oracle stays fresh."""
    settings = get_settings()
    await asyncio.to_thread(store.ensure)  # heavy sim + first estimate, off-loop
    try:
        from .attack import attack_snapshot  # warm the deterministic exhibit once

        await asyncio.to_thread(attack_snapshot)
    except Exception:  # pragma: no cover - defensive
        log.exception("attack snapshot warm-up failed")
    reader = get_reader()  # construct at startup so oracle env is read now
    futures = get_futures()  # on-chain futures desk (inventory-skewed curve)
    poster = OraclePoster(store)
    set_poster(poster)  # reachable for /terminal/data + /health provenance
    # Warm the on-chain read cache off the request path so /terminal/data never
    # blocks on slow remote-RPC reads (each read_all is 3 sequential eth_calls),
    # and seed the print-ts cursor above the on-chain latest so the poster's next
    # post is monotone (avoids 'non-monotone ts' reverts after a restart).
    if reader.configured:
        onchain = await asyncio.to_thread(reader.read_all, use_cache=False)
        latest_ts = max((v.get("timestamp", 0) for v in onchain.values()), default=0)
        if latest_ts:
            store.seed_cursor(latest_ts)
            log.info("seeded print-ts cursor above on-chain latest ts=%s", latest_ts)
        # Post-on-wake: if the on-chain record is overdue (the press slept through
        # its slot), post now instead of waiting out a full refresh cycle. Mirrors
        # the timer body (refresh first so the posted ts clears the seeded cursor).
        if poster.client.can_post() and _overdue_for_startup_post(
            onchain, settings.refresh_seconds, time.time()
        ):
            try:
                await asyncio.to_thread(store.refresh)
                await asyncio.to_thread(poster.post_latest)
                await asyncio.to_thread(reader.read_all, use_cache=False)
                log.info("posted overdue print on wake")
            except Exception:  # pragma: no cover - defensive
                log.exception("post-on-wake failed (timer loop continues)")
    if reader.configured:
        await _rehydrate_provenance(poster)
    # Warm the on-chain attestation summary too (catalog reads it) off-request.
    try:
        from .marketplace import warm_attestation_summary

        await asyncio.to_thread(warm_attestation_summary)
    except Exception:  # pragma: no cover - defensive
        log.exception("attestation summary warm-up failed")
    # Seed the term-structure skew from the live on-chain maker book (if any).
    if futures.configured:
        try:
            inv = await asyncio.to_thread(futures.maker_inventory, use_cache=False)
            store.set_maker_inventory(inv)
        except Exception:  # pragma: no cover - defensive
            log.exception("futures inventory warm-up failed")
    # Prime the /terminal/data cache off-loop so the first visitor is served the
    # shared dict, never a cold synchronous build (the free-tier OOM guard).
    try:
        await asyncio.to_thread(_rebuild_terminal_cache)
    except Exception:  # pragma: no cover - defensive
        log.exception("terminal payload warm-up failed")
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.refresh_seconds)
        except TimeoutError:
            pass
        if stop.is_set():
            break
        try:
            await asyncio.to_thread(store.refresh)
            if poster.client.can_post():
                await asyncio.to_thread(poster.post_latest)
            if reader.configured:  # refresh the on-chain caches after any new post
                await asyncio.to_thread(reader.read_all, use_cache=False)
                from .marketplace import warm_attestation_summary

                await asyncio.to_thread(warm_attestation_summary)
            if futures.configured:  # refresh the maker book so the curve skew tracks it
                inv = await asyncio.to_thread(futures.maker_inventory, use_cache=False)
                store.set_maker_inventory(inv)
            # Rebuild the /terminal/data cache off-loop so the served snapshot
            # reflects the fresh prints + on-chain reads (never on the request path).
            await asyncio.to_thread(_rebuild_terminal_cache)
        except Exception:  # pragma: no cover - keep the loop alive
            log.exception("refresh/post cycle failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()
    tasks = [asyncio.create_task(_background(stop)), asyncio.create_task(_warm_chain(stop))]
    try:
        yield
    finally:
        stop.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="ACR — The Arc Compute Rate", version="0.1.0", lifespan=lifespan)

# CORS so the public API is queryable cross-origin from browsers (the Terminal
# proxies server-side and doesn't need this, but direct API/`/docs` use does).
# Origins from ACR_CORS_ORIGINS ("*" default for the testnet demo; empty = off).
_cors = [o.strip() for o in (get_settings().cors_origins or "").split(",") if o.strip()]
if _cors:
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_credentials=False,  # public read API; "*" origins can't use credentials
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
    )


@app.exception_handler(PaymentRequired)
async def _payment_required_handler(request, exc: PaymentRequired):
    """Render the 402 challenge as its Gateway-shaped x402 JSON body
    (``{"x402Version": 2, "resource": {...}, "accepts": [...]}``) — what buyer
    SDKs parse — alongside the legacy challenge headers."""
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=exc.status_code, content=exc.body, headers=exc.headers)

GATED_ENDPOINTS = [
    "/prints",
    "/prints/{index_id}",
    "/curve/{index_id}",
    "/vol/{index_id}",
    "/seller-scores/{index_id}",
]


def require_known_index(index_id: str) -> str:
    """404 for an unknown index — declared BEFORE ``require_payment`` in every
    parametrized gated endpoint so a buyer is never charged (verify + settle is
    irrevocable in Circle mode) for a resource that cannot exist."""
    if index_id not in ALL_INDEX_IDS:
        raise HTTPException(status_code=404, detail=f"unknown index {index_id}")
    return index_id


@app.get("/")
def root() -> dict:
    return {
        "name": "ACR — The Arc Compute Rate",
        "tagline": "machine commerce just got its SOFR — and it prints its own attack cost",
        "indices": list(ALL_INDEX_IDS),
        "pricing": {
            "per_query_usdc": price_usdc(),
            "scheme": "x402",
            "network": get_settings().caip2(),
        },
        "gated_endpoints": GATED_ENDPOINTS,
        "marketplace": {"catalog": "/marketplace/catalog", "receipts": "/marketplace/receipts"},
    }


def _short_addr(addr: str | None) -> str | None:
    """``0x1234…abcd`` — enough to eyeball a wallet without leaking the full
    address into every health poll/log line."""
    return f"{addr[:6]}…{addr[-4:]}" if addr else None


@app.get("/health")
def health() -> dict:
    store.ensure()
    from urllib.parse import urlparse

    from acr_oracle_client.signer import build_signer

    s = get_settings()
    sg = build_signer(s)
    signer = "circle" if type(sg).__name__ == "CircleWalletSigner" else "local" if sg else "none"
    circle = isinstance(get_facilitator(), CircleFacilitator)
    # Most recent on-chain post across the poster's per-index provenance (or None
    # while offline) — the one-curl answer to "is the oracle actually posting?".
    last = [e for e in get_poster().last_posts.values() if e.get("tx")]
    poster_last_tx = max(last, key=lambda e: e.get("at_wall") or 0.0)["tx"] if last else None
    return {
        "status": "ok",
        "indices_live": len(store.latest),
        # Active modes — makes "why is my query 402ing / which path am I on" a
        # single curl. gate=dev accepts a mock header; gate=circle needs real x402.
        "gate": "circle" if circle else "dev",
        "signer": signer,
        "tape": s.tape_source,
        "oracle_configured": bool(s.oracle_address),
        # Wiring at a glance — chain, contracts, seller wallet, facilitator.
        "chain_id": s.arc_chain_id,
        "oracle_address": s.oracle_address or None,
        "registry_address": s.registry_address or None,
        "pay_to": _short_addr((s.x402_pay_to if circle else PAY_TO) or None),
        "facilitator_host": (urlparse(s.x402_facilitator_url).hostname
                             if s.x402_facilitator_url else None),
        "tape_source": s.tape_source,
        "poster_last_tx": poster_last_tx,
    }


@app.get("/x402/info")
def x402_info(fac: Facilitator = Depends(get_facilitator)) -> dict:
    """The payment gate, described dynamically (ungated). The Terminal's API
    console reads this to label the gate mode and drive the paid-query demo."""
    s = get_settings()
    circle = isinstance(fac, CircleFacilitator)
    return {
        "facilitator": "circle" if circle else "dev",
        "price_usdc": price_usdc(),
        "scheme": "x402",
        # CAIP-2 for BOTH gates — the catalog, receipts, and this descriptor
        # must name the same network or the Terminal surfaces disagree.
        "network": s.caip2(),
        "pay_to": (s.x402_pay_to if circle else PAY_TO) or None,
        "payment_header": "PAYMENT-SIGNATURE",
        "gated_endpoints": GATED_ENDPOINTS,
    }


@app.post("/webhooks/circle")
async def circle_webhook(request: Request) -> dict:
    """Inbound Circle webhook (ungated). Verifies the ECDSA P-256 signature over
    the RAW body, records the event, and always ACKs 200 so the subscription-
    confirmation ping activates the webhook even when a signature can't be
    verified. Unverified events are recorded as such and only displayed."""
    from .webhooks import get_webhook_store, summarize, verify_signature

    raw = await request.body()  # must read raw bytes before JSON parse (for the sig)
    verified = verify_signature(
        raw, request.headers.get("X-Circle-Signature"), request.headers.get("X-Circle-Key-Id")
    )
    try:
        payload = json.loads(raw) if raw else {}
        if not isinstance(payload, dict):
            payload = {"value": payload}
    except Exception:
        payload = {}
    etype, sub, summary = summarize(payload)
    from .webhooks import WebhookEvent

    get_webhook_store().record(
        WebhookEvent(
            id=str(payload.get("notificationId") or payload.get("id") or f"evt-{time.time():.0f}"),
            type=etype,
            verified=verified,
            received_at=time.time(),
            subscription_id=sub,
            summary=summary,
            payload=payload,
        )
    )
    return {"received": True}


@app.get("/webhooks/recent")
def webhooks_recent() -> dict:
    """Recent Circle webhook events for the Terminal's activity panel (ungated)."""
    from .webhooks import get_webhook_store

    store_wh = get_webhook_store()
    try:
        import cryptography  # noqa: F401

        verify_available = True
    except Exception:
        verify_available = False
    return {
        "events": store_wh.recent(25),
        "received": store_wh.received,
        "verify_available": verify_available,
        "note": "point a Circle Programmable Wallets webhook at POST /webhooks/circle",
    }


def provenance() -> dict:
    """Where the numbers in a paid response actually come from.

    An agent pays USDC for these endpoints and then acts on the answer, so it is
    entitled to know that the estimator — which is real — currently runs over a
    calibrated SIMULATED tape rather than observed settlement flow. That fact was
    visible in `/health` and in the Terminal's chrome, but not in the machine
    responses themselves, which is precisely where it matters most.

    ``tape`` is the honest tier: "sim" (synthetic flow), "arc" (real Arc USDC
    settlements) or "receipts" (this venue's own x402 ledger). ``estimator`` and
    the on-chain print are real in every tier.
    """
    s = get_settings()
    tape = (s.tape_source or "sim").lower()
    return {
        "tape": tape,
        "simulated_tape": tape == "sim",
        "estimator": "real",
        "chain": "arc-testnet" if s.oracle_address else None,
        "note": (
            "prices are estimated from a calibrated simulated tape; the estimator, "
            "the signature and the on-chain print are real"
            if tape == "sim"
            else f"prices are estimated from the {tape} tape"
        ),
    }


@app.get("/prints")
def prints(_: PaymentReceipt = Depends(require_payment)) -> dict:
    return {**store.snapshot(), "provenance": provenance()}


@app.get("/prints/{index_id}")
def print_one(
    index_id: str = Depends(require_known_index),
    _: PaymentReceipt = Depends(require_payment),
) -> dict:
    store.ensure()
    if index_id not in store.latest:
        raise HTTPException(status_code=404, detail=f"unknown index {index_id}")
    p = store.latest[index_id]
    d = store.diag[index_id]
    return {
        **p.model_dump(),
        "unit": spec_for(index_id).unit,
        "naive_vwap": d.naive_vwap,
        "cost_to_move_1pct": d.bound.cost_to_move_1pct,
        "cleaned_pct": 100 * d.cleaning.removed_fraction,
        "robustness": store.robustness(index_id),
        "provenance": provenance(),
    }


@app.get("/curve/{index_id}")
def curve(
    index_id: str = Depends(require_known_index),
    _: PaymentReceipt = Depends(require_payment),
) -> dict:
    return {"index_id": index_id, "curve": store.curve(index_id), "provenance": provenance()}


@app.get("/vol/{index_id}")
def vol(
    index_id: str = Depends(require_known_index),
    _: PaymentReceipt = Depends(require_payment),
) -> dict:
    return {"index_id": index_id, "annualized_vol": store.vol(index_id),
            "provenance": provenance()}


@app.get("/seller-scores/{index_id}")
def seller_scores(
    index_id: str = Depends(require_known_index),
    _: PaymentReceipt = Depends(require_payment),
) -> dict:
    return {"index_id": index_id, "sellers": store.seller_scores(index_id),
            "provenance": provenance()}


@app.get("/marketplace/catalog")
def marketplace_catalog(request: Request) -> dict:
    """Machine-readable listings of every paid ACR resource (ungated — discovery
    is free, the data costs). Bazaar-shaped items; a buyer agent reads this,
    picks a resource, and pays via x402."""
    from .marketplace import build_catalog

    return build_catalog(str(request.base_url))


@app.get("/marketplace/receipts")
def marketplace_receipts() -> dict:
    """The public settlement ledger — recent x402 receipts, newest first
    (ungated; it is the marketplace's proof-of-commerce tape)."""
    from .marketplace import build_receipts

    return build_receipts(get_facilitator())


@app.get("/onchain/{index_id}")
def onchain_print(index_id: str) -> dict:
    """The settlement-grade print read straight from ``ACROracle`` on-chain.

    Ungated (a public read of chain state). 503 if no oracle is configured;
    404 if the oracle has no print for this index yet.
    """
    reader = get_reader()
    if not reader.configured:
        raise HTTPException(status_code=503, detail="no oracle configured (set ACR_ORACLE_ADDRESS)")
    r = reader.read(index_id)
    if r is None:
        raise HTTPException(status_code=404, detail=f"no on-chain print for {index_id}")
    return {"source": "onchain", "oracle": reader.oracle_address, **r}


@app.get("/hedger")
def hedger_state(fac: Facilitator = Depends(get_facilitator)) -> dict:
    """The autonomous hedger's standing — mandate, position, fills, and spend.

    Ungated, and derived only from public data: the agent's position on the
    venue, the ``Traded`` events whose taker is the agent, and the settlement
    ledger rows whose payer is it. Nothing here depends on a log file from
    wherever the agent happened to run, so every number is one a reader can
    reproduce from the chain.
    """
    from . import hedger
    from .marketplace import build_receipts

    return hedger.build_hedger_state(get_futures(), build_receipts(fac))


@app.get("/futures")
def futures_roster() -> dict:
    """The whole on-chain futures venue for the Terminal's live desk + trade tape:
    the venue address, per-index desks, and recent fills (newest-first). Ungated;
    empty (venue null) when no ACRFutures is configured. This is the fast endpoint
    the desk polls — the heavy /terminal/data carries only the aggregate desks."""
    return get_futures().roster()


@app.get("/futures/{index_id}")
def futures_desk(index_id: str = Depends(require_known_index)) -> dict:
    """The live on-chain futures desk for an index — the maker's inventory,
    mark-to-oracle PnL, and settlement status, read from ``ACRFutures``.

    Ungated (a public read of chain state). 503 if no futures venue is
    configured; 404 if no series exists for this index yet.
    """
    futures = get_futures()
    if not futures.configured:
        raise HTTPException(status_code=503, detail="no futures venue configured (set ACR_FUTURES_ADDRESS)")
    desk = futures.read_desk(index_id)
    if desk is None:
        raise HTTPException(status_code=404, detail=f"no futures series for {index_id}")
    return {"source": "onchain", "futures": futures.futures_address, **desk}


def build_terminal_payload(store: PrintStore, reader, poster=None, fac=None) -> dict:
    """The full /terminal/data payload. ``scripts/gen_snapshot.py`` builds the
    Terminal's bundled offline snapshot from this same function, so the two
    can never drift."""
    from .attack import attack_snapshot

    settings = get_settings()
    fac = fac or get_facilitator()
    # The poster's signer address is lazy (a Circle-custody signer fetches it
    # over the network) — never let a provenance nicety fail the payload.
    signer_addr = None
    if poster is not None and getattr(poster.client, "signer", None) is not None:
        try:
            signer_addr = poster.client.signer.address
        except Exception:  # pragma: no cover - live Circle hiccup → honest null
            signer_addr = None
    store.ensure()
    onchain = reader.read_all()
    futures = get_futures()
    futures_desks = futures.read_all() if futures.configured else {}
    prints = {
        iid: {
            **store.latest[iid].model_dump(),
            "unit": spec_for(iid).unit,
            "naive_vwap": store.diag[iid].naive_vwap,
            "cost_to_move_1pct": store.diag[iid].bound.cost_to_move_1pct,
            "cleaned_pct": 100 * store.diag[iid].cleaning.removed_fraction,
            "vol": store.vol(iid),
            "curve": store.curve(iid),
            "robustness": store.robustness(iid),
            "onchain": onchain.get(iid),
        }
        for iid in store.latest
    }
    return {
        "prints": prints,
        # Recent print history (the deque already exists) — sparklines and the
        # index-detail history chart. Capped at 96 points per index.
        "history": {
            iid: [
                {"ts": p.ts, "value": p.value, "ci_lo": p.ci_lo, "ci_hi": p.ci_hi}
                for p in list(store.history.get(iid, []))[-96:]
            ]
            for iid in store.latest
        },
        # Seller reliability for the human Registry view; the machine endpoint
        # /seller-scores/{id} stays x402-gated.
        "sellers": {iid: store.seller_scores(iid) for iid in store.latest},
        # The on-chain futures desk per index (maker inventory, mark-to-oracle
        # PnL, settlement) — empty {} when no ACRFutures venue is configured.
        "futures": futures_desks,
        "attack": attack_snapshot(),
        "oracle": reader.oracle_address if reader.configured else None,
        # Network identity card — the frontend contract for every chain-aware
        # surface (explorer links, gate badge, poster provenance). Shape is fixed.
        "chain": {
            "name": "Arc Testnet",
            "chain_id": settings.arc_chain_id,
            "caip2": settings.caip2(),
            "rpc_url": settings.arc_rpc_url,
            "explorer_base": settings.explorer_base,
            "usdc_address": settings.usdc_address,
            "gateway_wallet": settings.x402_gateway_wallet,
            "oracle_address": settings.oracle_address or None,
            "registry_address": settings.registry_address or None,
            "futures_address": settings.futures_address or None,
            "gate": "circle" if isinstance(fac, CircleFacilitator) else "dev",
            "tape_source": settings.tape_source,
            "signer": signer_addr,
            "poster": {"posts": poster.posts, "last": poster.last_posts} if poster else None,
        },
    }


def _build_payload_locked() -> dict:
    """Build the /terminal/data payload + store it in the module cache. Heavy
    (sim estimate + attack exhibit + on-chain reads). The caller MUST hold
    ``_terminal_payload_lock`` so two heavy builds never run at once — the whole
    point of the cache on a 512MB box."""
    global _terminal_payload_cache
    _terminal_payload_cache = build_terminal_payload(
        store, get_reader(), poster=get_poster(), fac=get_facilitator()
    )
    return _terminal_payload_cache


def _rebuild_terminal_cache() -> dict:
    """Force-rebuild the cache (the background loop, after each warm/refresh) —
    lock-guarded so it can never run concurrently with a cold request's build."""
    with _terminal_payload_lock:
        return _build_payload_locked()


@app.get("/terminal/data")
def terminal_data() -> dict:
    """Ungated snapshot for the human-facing ACR Terminal (prints + curve + vol).

    The Terminal is the human view; the x402 gate applies to the machine API.
    Includes a live attack comparison so the 'Attack the Index' panel renders,
    and — when an oracle is configured — the on-chain print for provenance.

    Served from a background-maintained cache: the request path never runs the
    heavy build concurrently, so N simultaneous visitors on the 512MB free tier
    can't OOM-spiral the box (a single shared dict, ~13KB, is returned instead).
    """
    cached = _terminal_payload_cache
    if cached is not None:
        return cached
    # Pre-warm window (before the background loop has built the cache): build once
    # under the lock — concurrent cold requests AND the background loop all
    # serialize here, so the box never runs parallel heavy builds. First waiter
    # builds + caches; the rest return that dict.
    with _terminal_payload_lock:
        if _terminal_payload_cache is not None:
            return _terminal_payload_cache
        return _build_payload_locked()


class AttackStartRequest(BaseModel):
    budget_usdc: float = 8000.0
    target_multiplier: float = 2.5
    seed: int | None = None


# Strong refs to in-flight demo tasks — an un-referenced asyncio task may be
# garbage-collected mid-run.
_demo_tasks: set[asyncio.Task] = set()


@app.post("/demo/attack/start")
async def demo_attack_start(req: AttackStartRequest | None = None) -> dict:
    """Kick a live wash-flow attack run for the Terminal's Attack Lab (ungated —
    it drives the human demo). Single-flight: 409 while a run is in progress."""
    from . import demo

    r = req or AttackStartRequest()
    budget = min(50_000.0, max(500.0, r.budget_usdc))
    mult = min(5.0, max(1.1, r.target_multiplier))
    seed = r.seed if r.seed is not None else int(time.time()) % 1_000_000
    if not demo.try_start(budget, mult, seed):
        raise HTTPException(status_code=409, detail="an attack run is already in flight")
    task = asyncio.create_task(asyncio.to_thread(demo.execute, budget, mult, seed))
    _demo_tasks.add(task)
    task.add_done_callback(_demo_tasks.discard)
    return {
        "state": "running",
        "params": {"budget_usdc": budget, "target_multiplier": mult, "seed": seed},
    }


@app.get("/demo/attack/status")
def demo_attack_status() -> dict:
    from . import demo

    return demo.status()


class BuyerStartRequest(BaseModel):
    count: int = 20
    delay_ms: int = 400


@app.post("/demo/buyer/start")
async def demo_buyer_start(req: BuyerStartRequest | None = None) -> dict:
    """Release the Exchange's floor buyer (ungated — it drives the human demo):
    N real x402 two-act exchanges through this app's own gate, receipts landing
    on the public ledger/tape. Dev gate only — the mock header fails closed on
    the Circle gate by design (use apps/agent with a funded wallet there)."""
    from . import buyer_demo

    if isinstance(get_facilitator(), CircleFacilitator):
        raise HTTPException(
            status_code=409,
            detail="live Circle gate — the in-page buyer pays the dev gate only; "
            "run apps/agent with a funded wallet instead",
        )
    r = req or BuyerStartRequest()
    count = min(50, max(1, r.count))
    delay_s = min(2.0, max(0.0, r.delay_ms / 1000))
    payer = buyer_demo.new_payer()
    if not buyer_demo.try_start(count, payer):
        raise HTTPException(status_code=409, detail="a buyer run is already on the floor")
    task = asyncio.create_task(buyer_demo.execute(app, count, delay_s, payer))
    _demo_tasks.add(task)
    task.add_done_callback(_demo_tasks.discard)
    return {"state": "running", "count": count, "payer": payer}


# --- the Public Desk: user-controlled wallets trading ACRFutures -----------


class DeskSessionRequest(BaseModel):
    user_id: str


class DeskFaucetRequest(BaseModel):
    # No address: the destination is derived from the session token, so a
    # caller cannot choose where the faucet sends money (see desk.drip_stake).
    user_token: str


class DeskChallengeRequest(BaseModel):
    user_token: str
    wallet_id: str
    action: str  # approve | collateral | trade | withdraw
    index_id: str = "ACR-GPU"
    qty: float = 0.0
    address: str = ""  # the SCA — lets the server size the action to live margin
    series_id: int | None = None  # withdraw: which series to empty


class DeskLimitsRequest(BaseModel):
    address: str
    index_id: str = "ACR-GPU"


class DeskWithdrawableRequest(BaseModel):
    address: str


def _desk_call(fn, *args):
    from .desk import DeskError

    try:
        return fn(*args)
    except DeskError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from e


@app.post("/desk/session")
def desk_session(req: DeskSessionRequest, request: Request) -> dict:
    """Open (or resume) a Public Desk session: Circle user + 60-min token, a
    PIN-setup challenge on first contact, the existing SCA wallet afterwards.
    Ungated — the desk IS the demo; guardrails live in desk.py."""
    ratelimit.check(request, "session", req.user_id)
    from . import desk

    return _desk_call(desk.open_session, req.user_id)


class DeskWalletRequest(BaseModel):
    user_token: str


@app.post("/desk/wallet")
def desk_wallet(req: DeskWalletRequest, request: Request) -> dict:
    """The session's ARC-TESTNET wallet + its USDC stake (null pre-PIN).
    POST so the session token stays out of URLs and access logs."""
    ratelimit.check(request, "wallet", ratelimit.session_ident(req.user_token))
    from . import desk

    w = _desk_call(desk.wallet_of, req.user_token)
    if w is None:
        return {"wallet": None, "usdc": None}
    # USDC *is* Arc's native token — the 0x3600… predeploy is its ERC-20 view of
    # the same balance, so the native read (18-dec) is the 6-dec ERC-20 amount.
    # A throttled read degrades to null rather than a failed desk step.
    return {
        "wallet": w,
        "usdc": desk._wallet_usdc(w["address"]),
        "faucet": desk.get_ledger().status(w["address"]),
    }


@app.post("/desk/faucet")
def desk_faucet(req: DeskFaucetRequest, request: Request) -> dict:
    """Claim + start the one-per-wallet 0.5 USDC stake from the custody wallet.
    The destination is THIS SESSION'S wallet — never a caller-supplied address.
    Returns as soon as the slot is reserved: Circle's confirm poll outlives any
    sane HTTP timeout, so the drip lands on a background thread and the client
    watches its wallet balance."""
    # Per SESSION, not per source IP: every reader reaches this through the same
    # Vercel proxy, so an IP-keyed faucet limit is a global one. The one-drip-
    # per-address rule that actually protects the custody wallet lives in
    # desk.FaucetLedger.claim, which this cannot weaken.
    ratelimit.check(request, "faucet", ratelimit.session_ident(req.user_token))
    from . import desk

    return _desk_call(desk.drip_stake, req.user_token)


@app.post("/desk/limits")
def desk_limits(req: DeskLimitsRequest, request: Request) -> dict:
    """The live per-direction size caps for this wallet — what the desk may
    offer without minting a challenge the contract would revert."""
    ratelimit.check(request, "limits", req.address)
    from . import desk

    return _desk_call(desk.desk_limits, req.address, req.index_id)


@app.post("/desk/withdrawable")
def desk_withdrawable(req: DeskWithdrawableRequest, request: Request) -> dict:
    """What this wallet can take back out, across every series it holds
    collateral in — including expired and settled ones, which is exactly where
    a reader needs an exit and where the tradable-series gate refuses to look."""
    ratelimit.check(request, "withdrawable", req.address)
    from . import desk

    return _desk_call(desk.withdrawable, req.address)


@app.post("/desk/challenge")
def desk_challenge(req: DeskChallengeRequest, request: Request) -> dict:
    """Mint the contractExecution challenge for one desk action; the browser
    SDK executes it under the user's PIN."""
    ratelimit.check(request, "challenge", ratelimit.session_ident(req.user_token))
    from . import desk

    return _desk_call(
        desk.build_challenge,
        req.user_token,
        req.wallet_id,
        req.action,
        req.index_id,
        req.qty,
        req.address,
        req.series_id,
    )


@app.get("/demo/buyer/status")
def demo_buyer_status() -> dict:
    from . import buyer_demo

    return buyer_demo.status()


@app.get("/revenue")
def revenue(fac: Facilitator = Depends(get_facilitator)) -> dict:
    return {
        "paid_queries": fac.paid_queries,
        "revenue_usdc": fac.revenue_usdc,
        "price_usdc": price_usdc(),
        "recent": [
            {"payer": r.payer, "amount_usdc": r.amount_usdc, "tx_ref": r.tx_ref}
            for r in list(fac.recent)[-10:]
        ],
        "note": "the index about machine commerce, bought by machines",
    }
