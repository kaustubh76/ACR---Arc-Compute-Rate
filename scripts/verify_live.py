#!/usr/bin/env python
"""Prove the DEPLOYED product is live — every pillar, one command, one exit code.

``verify_deploy.py`` checks the contracts and ``desk_preflight.py`` checks the
desk's own gates; both read the chain and the local config. Neither answers the
question that actually matters before someone opens the site: **is the thing on
the internet working right now?** That question has been answered by hand, per
surface, and the gaps show — a settled series served as the live desk, a public
tape blank two hours in five, and `poster_last_tx: null` while three real posts
sat on chain. Each was found by looking, and each could have been found by a
check that runs.

Read-only and safe to run against production at any cadence: no writes, no
faucet drips, no Circle users created.

    uv run python scripts/verify_live.py          # == make verify-live
    VERIFY_STRICT=1 …                             # crons + runway also fail
    ACR_API_URL=… ACR_TERMINAL_URL=… …            # point at another deploy

Exit codes: 0 = every pillar live; 1 = something a visitor would notice.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

from acr_oracle_client.futures import _rpc_retry, collateral_or_none

API = os.environ.get("ACR_API_URL", "https://acr-api-1fto.onrender.com").rstrip("/")
TERMINAL = os.environ.get(
    "ACR_TERMINAL_URL", "https://arc-compute-rate.vercel.app"
).rstrip("/")
#: Free-tier hosts sleep; a cold start is slow but not a fault.
TIMEOUT_S = float(os.environ.get("VERIFY_TIMEOUT_S", "90"))
#: HARD failure: ACRFutures.MAX_SETTLE_AGE is 7200s, so a print older than this
#: means the venue cannot be settled at all — not a slow press, a broken one.
PRINT_MAX_AGE_S = float(os.environ.get("VERIFY_PRINT_MAX_AGE_S", "7200"))
#: WARN: the press posts hourly, so 90 minutes means it has already missed a
#: slot and is heading for the settle window. Catching it here is the whole
#: point — a 216-minute gap went unnoticed because nothing looked until the
#: damage was done.
PRINT_WARN_AGE_S = float(os.environ.get("VERIFY_PRINT_WARN_AGE_S", "5400"))
#: Below this many days of gas, a wallet is a scheduled outage.
MIN_RUNWAY_DAYS = float(os.environ.get("VERIFY_MIN_RUNWAY_DAYS", "3"))
#: The venue's custody wallets need enough to open AND collateralize a series
#: (default roll: 1.5 collateral + gas). Below this a roll fails on its budget
#: guard, which is a silent expiry rather than a loud error.
VENUE_WALLET_FLOOR_USDC = float(os.environ.get("VERIFY_VENUE_FLOOR_USDC", "2.5"))
#: GitHub drops most scheduled ticks on a private repo, so "recent" has to be
#: generous or this check cries wolf — which is worse than not checking.
CRON_MAX_AGE_S = float(os.environ.get("VERIFY_CRON_MAX_AGE_S", "21600"))
STRICT = os.environ.get("VERIFY_STRICT", "") not in ("", "0", "false")

GATED = ["/prints/ACR-INF", "/curve/ACR-INF", "/vol/ACR-INF", "/seller-scores/ACR-INF"]
UNGATED = ["/onchain/ACR-INF", "/marketplace/catalog", "/revenue", "/x402/info"]
ROUTES = ["/", "/curve", "/developers", "/sellers"]

_failures: list[str] = []
_warnings: list[str] = []


def section(fn, *args):
    """Run one pillar's checks, converting a crash into a recorded failure.

    Every chain call here can meet Arc's 429, and an unguarded one takes the
    whole run down with a traceback instead of a verdict — the single worst
    outcome for a liveness gate, because a stack trace in CI reads as "the
    checker is broken" and gets muted. A throttled section reports itself and
    the rest still run.
    """
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 — a verdict beats a traceback
        check(False, f"{fn.__name__} could not complete: {str(exc)[:90]}", warn_only=True)
        return None


def check(ok: bool, label: str, *, warn_only: bool = False) -> bool:
    """Record and print one result. ``warn_only`` marks the things that depend
    on somebody else's scheduler rather than on our code being correct."""
    if ok:
        mark = "✓"
    elif warn_only and not STRICT:
        mark = "!"
        _warnings.append(label)
    else:
        mark = "✗"
        _failures.append(label)
    print(f"  {mark} {label}")
    return ok


def _parse(raw: bytes) -> dict | None:
    """JSON if it is JSON, else None. The page routes serve HTML, and a checker
    that reports 0 because it could not parse a body it never needed is a
    checker that cries wolf — the status is the whole assertion there."""
    try:
        return json.loads(raw or b"null")
    except Exception:
        return None


def get(url: str) -> tuple[int, dict | None]:
    """HTTP GET returning (status, parsed-json-or-None). A 402 body is a real
    answer here, not an error, so read the payload either way."""
    req = urllib.request.Request(url, headers={"User-Agent": "acr-verify-live"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310
            return r.status, _parse(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _parse(e.read())
    except Exception:
        return 0, None


def post(url: str, body: dict) -> tuple[int, dict | None]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "acr-verify-live"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310
            return r.status, _parse(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _parse(e.read())
    except Exception:
        return 0, None


# --- pillars ----------------------------------------------------------------


def verify_oracle(w3, settings) -> None:
    from acr_oracle_client import OracleClient

    print("\noracle — the index other contracts settle against")
    oc = OracleClient(rpc_url=settings.arc_rpc_url, oracle_address=settings.oracle_address)
    now = time.time()
    for iid in ("ACR-GPU", "ACR-INF", "ACR-DATA"):
        p = oc.read_latest(iid)
        if not p or not p.get("value"):
            check(False, f"{iid}: no on-chain print")
            continue
        age = now - (p.get("posted_at") or 0)
        # Two thresholds, because "late" and "unsettleable" are different
        # failures and only one of them is an outage.
        check(
            age < PRINT_MAX_AGE_S,
            f"{iid} = {p['value']:.5f}, posted {age / 60:.0f}m ago"
            + (" — PAST THE SETTLE WINDOW" if age >= PRINT_MAX_AGE_S else ""),
        )
        if PRINT_WARN_AGE_S <= age < PRINT_MAX_AGE_S:
            check(False, f"{iid} print is {age / 60:.0f}m old — the press has missed a slot",
                  warn_only=True)


def verify_venue(w3, settings) -> dict | None:
    """The live series, returned so later checks can assert against the SAME one
    the chain says is live — that asymmetry is where a dead series slipped
    through before."""
    from acr_oracle_client import FuturesClient

    print("\nvenue — ACRFutures, where the index becomes a position")
    if not settings.futures_address:
        check(False, "ACR_FUTURES_ADDRESS unset")
        return None
    fc = FuturesClient(rpc_url=settings.arc_rpc_url, futures_address=settings.futures_address)
    now = int(_rpc_retry(lambda: w3.eth.get_block("latest"))["timestamp"])
    live = [s for s in fc.read_all_series() if not s["settled"] and s["expiry_ts"] > now]
    if not check(bool(live), "a live, unexpired series exists"):
        return None
    s = max(live, key=lambda x: x["series_id"])
    left_h = (s["expiry_ts"] - now) / 3600
    check(left_h > 24, f"series {s['series_id']} ({s['index_id']}) has {left_h:.0f}h left")

    # `collateral_of(...) or 0.0` is the spelling this project has a helper to
    # avoid: it turns a THROTTLED READ into an empty account, and here that made
    # the verifier announce an uncollateralized venue whenever Arc was busy —
    # crying outage over RPC weather.
    maker_addr = w3.to_checksum_address(s["maker"])
    maker = collateral_or_none(fc, s["series_id"], maker_addr)
    if maker is None:
        check(False, "maker collateral: the chain would not say", warn_only=True)
    else:
        check(maker > 0, f"maker is collateralized ({maker:.2f} USDC) — it is the counterparty")

    # Collateral is PER SERIES, and a roll posts a fresh stake without reclaiming
    # the old one — so every roll silently leaves the maker's money on a series
    # nobody trades. Measured on 08-03: 4.50 USDC sat on series 1 while the desk
    # quoted series 2 off 1.50, and since `feasible_qty` clamps a reader's size
    # by the maker's stake, the public book was a quarter of the depth the
    # project had already paid for. Nothing was broken, so nothing complained.
    stranded = 0.0
    unreadable = 0
    for other in fc.read_all_series():
        if other["series_id"] == s["series_id"]:
            continue
        c = collateral_or_none(fc, other["series_id"], maker_addr, tries=2)
        if c is None:
            unreadable += 1
        elif c > 0:
            stranded += c
    if unreadable:
        check(False, f"{unreadable} series' maker balance unreadable", warn_only=True)
    # Deliberately does NOT promise the money back: part of a balance on an old
    # series is initial margin for a position still open there, which the
    # contract will not release. `futures_withdraw.py` sizes that properly (via
    # the same `free_collateral_units` the desk quotes readers); this check only
    # says where to look. A verifier that names a command which then recovers
    # nothing has told you something false in the course of being helpful.
    check(
        stranded == 0.0,
        "no maker collateral sitting off the traded series"
        + (
            f" (found {stranded:.2f} USDC on other series — run "
            "`make futures-withdraw` with WITHDRAW_DRY_RUN=1 to see how much "
            "of it is actually free)"
            if stranded
            else ""
        ),
        warn_only=True,
    )

    # A venue with a live series but no taker stake is a book nobody can trade
    # into: every desk fill mirrors onto the maker, but the heartbeat's own
    # trades need its stake to still be on THIS series after a roll.
    n = int(_rpc_retry(fc._contract().functions.traderCount(s["series_id"]).call))
    check(n >= 1, f"{n} trader(s) posted on the live series")
    return s


def verify_tape(settings) -> None:
    from acr_oracle_client import FuturesClient
    from acr_oracle_client.futures import TAPE_PAGE_BLOCKS

    # A CROSS-CHECK, not the verdict. This issues its own uncached getLogs and
    # so competes with the product for the same throttled Arc RPC — under load
    # it can come back empty while the terminal, serving a warmed cache, shows a
    # full tape. The visitor-facing assertion is the terminal's tape in
    # verify_terminal(), which is hard-failing; making this one hard too would
    # turn RPC weather into a false outage.
    print("\ntape — cross-check that fills exist on chain (product's tape is the verdict)")
    fc = FuturesClient(rpc_url=settings.arc_rpc_url, futures_address=settings.futures_address)
    w3 = fc._connect()
    tip = int(_rpc_retry(lambda: w3.eth.block_number))
    fills = fc.recent_trades()
    if not check(bool(fills), "recent fills readable direct from chain", warn_only=True):
        return
    oldest = min(f["block"] for f in fills)
    # Depth is warn-only ON PURPOSE. Paging stops on a throttle by design — a
    # shorter tape now beats a complete one a minute from now — so a single
    # probe can legitimately come back one page deep while the product, which
    # serves this warmed and cached, shows the full reach. Failing a liveness
    # run on the RPC's mood would make it cry wolf, and the terminal's own tape
    # check below is the assertion that reflects what a visitor actually sees.
    check(
        tip - oldest > TAPE_PAGE_BLOCKS or len(fills) >= 3,
        f"{len(fills)} fills, reaching {(tip - oldest) * 0.510 / 3600:.1f}h back",
        warn_only=True,
    )


def verify_seller() -> dict | None:
    print("\nseller — the paid API")
    status, health = get(f"{API}/health")
    if not check(status == 200 and bool(health), f"{API}/health"):
        return None
    check(health.get("oracle_configured") is True, "oracle configured")
    check(health.get("indices_live") == 3, f"{health.get('indices_live')}/3 indices live")
    # The defect this was written for: the press posts, but the product says
    # "awaiting first live post" because in-memory provenance never rehydrated.
    check(
        bool(health.get("poster_last_tx")),
        f"poster provenance present ({str(health.get('poster_last_tx'))[:14]}…)",
    )
    return health


def verify_x402() -> None:
    print("\nx402 — the gate that makes the data a product")
    for path in GATED:
        status, body = get(f"{API}{path}")
        a = ((body or {}).get("accepts") or [{}])[0]
        ok = status == 402 and a.get("scheme") == "exact" and a.get("payTo")
        # Report the status we GOT, never the one we wanted — a failure line
        # that prints the expected value is a failure line that misleads.
        detail = f"{a.get('network')} {a.get('maxAmountRequired')}" if ok else "no payment terms"
        check(bool(ok), f"{path} -> {status} {detail}")
    for path in UNGATED:
        status, _ = get(f"{API}{path}")
        check(status == 200, f"{path} -> {status} (ungated)")


def verify_desk(live_series: dict | None) -> None:
    print("\npublic desk — a reader trading from their own wallet")
    addr = "0x95DE70736E21e70DF921Fb3ab91dD56750965b59"  # a real past desk wallet
    status, body = post(f"{API}/desk/withdrawable", {"address": addr})
    check(status == 200 and body is not None, f"/desk/withdrawable -> {status}")
    status, body = post(
        f"{API}/desk/limits", {"address": addr, "index_id": "ACR-INF"}
    )
    ok = status == 200 and isinstance(body, dict) and body.get("mark", 0) > 0
    check(ok, f"/desk/limits -> {status}" + (f", mark {body.get('mark'):.5f}" if ok else ""))
    if ok and live_series is not None:
        # The desk must quote the series the CHAIN says is live. Quoting a
        # settled one is how a reader ends up authorizing a doomed trade.
        check(
            body.get("series_id") == live_series["series_id"],
            f"desk quotes series {body.get('series_id')} == live series "
            f"{live_series['series_id']}",
        )


def verify_hedger() -> None:
    """The autonomous agent — did it actually pay and trade, or is it a panel?

    This lives here rather than in a dispatch workflow ON PURPOSE. Running the
    hedger from CI would mean shipping the Circle agent wallet's session into
    GitHub secrets — an email-authenticated credential that expires in weeks,
    which is exactly the "wrong tool for unattended automation" argument
    docs/WALLETS.md makes about agent wallets. This check needs no credential at
    all: it reads public state and asserts the evidence is there, so the public
    run record comes from the 10-minute keepalive for free.

    Warn-only: the agent is operator-run, so "has not traded recently" is a fact
    about the demo schedule, not an outage.
    """
    print("\nautonomous hedger — the agent that pays for what it trades on")
    status, body = get(f"{API}/hedger")
    if not check(status == 200 and isinstance(body, dict), f"/hedger -> {status}"):
        return
    if not body.get("configured"):
        check(False, "no hedger agent configured on this deployment", warn_only=True)
        return
    check(bool(body.get("agent")), f"agent wallet {str(body.get('agent'))[:12]}…")
    # Two identities, one agent — the pair is the point, so check both are named.
    check(
        bool(body.get("payer")),
        f"pays as {str(body.get('payer'))[:12]}… (the smart account's backing EOA)",
        warn_only=True,
    )
    fills = body.get("fills") or []
    check(len(fills) > 0, f"{len(fills)} on-chain fill(s) by the agent", warn_only=True)
    paid = body.get("paid_queries")
    check(
        bool(paid),
        f"{paid} x402 settlement(s) from the agent — it paid for the data it traded on",
        warn_only=True,
    )
    pos, gap = body.get("position_contracts"), body.get("gap_contracts")
    if pos is not None:
        check(True, f"position {pos:+.2f} against a mandate of "
                    f"{body.get('target_contracts')} (gap {gap:+.2f})")


def verify_terminal(live_series: dict | None) -> None:
    print("\nterminal — the public surface")
    for path in ROUTES:
        status, _ = get(f"{TERMINAL}{path}")
        check(status == 200, f"{path} -> {status}")
    status, body = get(f"{TERMINAL}/api/futures")
    payload = (body or {}).get("data") or body or {}
    desks = payload.get("desks") or {}
    check(status == 200 and bool(desks), f"/api/futures -> {status}, {len(desks)} desk(s)")
    if desks and live_series is not None:
        # The check that would have caught a throttled crawl publishing a
        # settled series as the live desk.
        shown = {d.get("series_id") for d in desks.values()}
        check(
            live_series["series_id"] in shown and not any(d.get("settled") for d in desks.values()),
            f"terminal shows the live series {sorted(shown)}, none settled",
        )
    check(len(payload.get("trades") or []) > 0, f"{len(payload.get('trades') or [])} fill(s) on the public tape")


def verify_funding(w3, settings) -> None:
    """Gas is the failure nobody gets warned about: everything works until it
    doesn't, and then every pillar dies at once."""
    from index_api.desk import (
        FAUCET_RESERVE_USDC,
        FAUCET_USDC,
        PRESS_BURN_USDC_PER_DAY,
    )

    print("\nfunding — the runway under all of it")
    wallets: list[tuple[str, str, float]] = []
    # A balance is public information, so prefer a plain address over Circle
    # credentials. This check runs in CI, and the alternative — putting the
    # entity secret in repository secrets — would hand a warn-only balance read
    # the ability to move custody funds. Never buy a nice-to-have with an
    # escalation of what a compromised runner could do.
    custody = os.environ.get("ACR_CUSTODY_ADDRESS", "").strip()
    if not custody:
        try:
            from acr_oracle_client.signer import CircleWalletSigner

            custody = CircleWalletSigner(
                wallet_id=settings.circle_wallet_id,
                api_key=settings.circle_api_key,
                entity_secret=settings.circle_entity_secret,
                base_url=settings.circle_base_url,
            ).address
        except Exception as exc:
            check(
                False,
                f"custody wallet unknown — set ACR_CUSTODY_ADDRESS ({str(exc)[:40]})",
                warn_only=True,
            )
    if custody:
        wallets.append(("custody (press + faucet)", custody, PRESS_BURN_USDC_PER_DAY))

    for label, addr, burn in wallets:
        bal = _rpc_retry(w3.eth.get_balance, w3.to_checksum_address(addr)) / 1e18
        days = bal / burn if burn > 0 else float("inf")
        check(
            days >= MIN_RUNWAY_DAYS,
            f"{label}: {bal:.3f} USDC = {days:.0f} days at {burn}/day",
            warn_only=True,
        )
        # The faucet and the press share this wallet, so say plainly how many
        # readers can still be onboarded before the floor bites.
        drips = max(0, int((bal - FAUCET_RESERVE_USDC) / FAUCET_USDC))
        check(
            drips > 0,
            f"{drips} faucet drip(s) left above the {FAUCET_RESERVE_USDC} USDC press floor",
            warn_only=True,
        )

    # The venue's own custody wallets. This section watched the press wallet
    # only, so the wallets that actually pay to roll a series and keep the tape
    # moving could run dry with nothing saying so — and on Arc "out of USDC"
    # means "cannot transact at all", not merely "cannot post collateral".
    from acr_oracle_client import build_role_signer

    for role, why in (
        ("maker", "stands behind the book; pays to open + collateralize each series"),
        ("taker", "the hourly heartbeat that keeps the tape moving"),
    ):
        try:
            sg = build_role_signer(role, settings)
            if sg is None or type(sg).__name__ != "CircleWalletSigner":
                continue  # not migrated on this deployment; nothing to check
            bal = _rpc_retry(w3.eth.get_balance, w3.to_checksum_address(sg.address)) / 1e18
        except Exception as exc:  # noqa: BLE001 — a verdict beats a traceback
            check(False, f"{role} wallet unreadable ({str(exc)[:40]})", warn_only=True)
            continue
        check(
            bal >= VENUE_WALLET_FLOOR_USDC,
            f"{role} custody wallet {sg.address[:10]}…: {bal:.3f} USDC "
            f"(floor {VENUE_WALLET_FLOOR_USDC}) — {why}",
            warn_only=True,
        )


def verify_crons() -> None:
    """Warn-only by default: GitHub drops most scheduled ticks on a private
    repo, so a strict check here would be red more often than the product is
    broken — and an alarm that cries wolf gets ignored."""
    import subprocess

    print("\nautomation — the jobs that keep the book alive")
    for wf in ("futures-heartbeat.yml", "futures-lifecycle.yml"):
        try:
            out = subprocess.run(
                ["gh", "run", "list", "--workflow", wf, "--limit", "1",
                 "--json", "conclusion,createdAt", "-q",
                 '.[0] | "\\(.conclusion) \\(.createdAt)"'],
                capture_output=True, text=True, timeout=60,
            ).stdout.strip()
            concl, _, when = out.partition(" ")
            age = time.time() - time.mktime(time.strptime(when, "%Y-%m-%dT%H:%M:%SZ"))
            check(
                concl == "success" and age < CRON_MAX_AGE_S,
                f"{wf}: {concl}, {age / 3600:.1f}h ago",
                warn_only=True,
            )
        except Exception as exc:
            check(False, f"{wf}: could not read runs ({str(exc)[:40]})", warn_only=True)


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    from acr_core import get_settings
    from web3 import Web3

    s = get_settings()
    print(f"ACR liveness — api {API}\n               terminal {TERMINAL}")
    w3 = Web3(Web3.HTTPProvider(s.arc_rpc_url, request_kwargs={"timeout": 25}))
    if not check(w3.is_connected(), f"Arc RPC reachable ({s.arc_rpc_url})"):
        print("\nliveness: FAILED — no chain, nothing else is meaningful")
        sys.exit(1)
    cid = int(_rpc_retry(lambda: w3.eth.chain_id))
    check(cid == s.arc_chain_id, f"chain id {cid}")

    section(verify_oracle, w3, s)
    live = section(verify_venue, w3, s)
    section(verify_tape, s)
    section(verify_seller)
    section(verify_x402)
    section(verify_desk, live)
    section(verify_hedger)
    section(verify_terminal, live)
    section(verify_funding, w3, s)
    section(verify_crons)

    print()
    if _warnings:
        print(f"  {len(_warnings)} warning(s) — degraded, not down:")
        for w in _warnings:
            print(f"    ! {w}")
    if _failures:
        print(f"\nliveness: FAILED — {len(_failures)} check(s) a visitor would notice")
        for f in _failures:
            print(f"    ✗ {f}")
        sys.exit(1)
    print("liveness: ALL PILLARS LIVE")
    sys.exit(0)


if __name__ == "__main__":
    main()
