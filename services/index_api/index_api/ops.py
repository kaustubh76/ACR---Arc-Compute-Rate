"""The systems ledger — what the operator knows, served instead of typed.

``scripts/verify_live.py`` answers "is the thing on the internet working right
now?" by probing the deployment from OUTSIDE, over HTTP, from a laptop. That is
the right shape for a gate and it stays exactly as it is: unchanged, still the
CI/``make verify-live`` path, still the only thing that can catch a Vercel route
serving a 500 or a cron GitHub silently dropped.

This module answers a different question — "what does the press itself
currently believe?" — from INSIDE the process, over state it already holds.
The distinction matters and is not a technicality:

  * An in-process checker must not HTTP-probe its own API. A check that curls
    ``/prints`` from the process serving ``/prints`` proves the socket is open
    and nothing else; on a free-tier host it also competes with the requests it
    is meant to be reassuring you about.
  * The expensive reads (venue scan, oracle prints) are ALREADY memoized by the
    warm loop. Reporting off those memos costs approximately nothing, where a
    fresh probe of each would be the most expensive thing the service does.
  * verify_live must fail loudly on a laptop. This must never fail at all — it
    is a dashboard, and a dashboard that can take the press down with it is
    worse than no dashboard.

So: no writes, no chain calls of its own beyond the shared readers, every
section wrapped, and an honest ``unknown`` wherever a read did not land. Unread
is never rendered as zero — that is the same rule the Terminal lives by, and it
is exactly as load-bearing here, where a zeroed panel reads as an outage.
"""

from __future__ import annotations

import logging
import os
import statistics
import time

log = logging.getLogger("acr.ops")

#: A print older than this cannot settle the venue at all — ACRFutures'
#: MAX_SETTLE_AGE. Mirrors scripts/verify_live.py's PRINT_MAX_AGE_S so the
#: dashboard and the gate cannot disagree about what "broken" means.
PRINT_MAX_AGE_S = float(os.environ.get("VERIFY_PRINT_MAX_AGE_S", "7200"))
#: The press posts hourly, so 90 minutes means a slot was already missed and
#: the settle window is in sight. Warn, don't fail.
PRINT_WARN_AGE_S = float(os.environ.get("VERIFY_PRINT_WARN_AGE_S", "5400"))
#: Below this a roll fails on its own budget guard — a silent expiry.
VENUE_WALLET_FLOOR_USDC = float(os.environ.get("VERIFY_VENUE_FLOOR_USDC", "2.5"))
TAKER_WALLET_FLOOR_USDC = float(os.environ.get("VERIFY_TAKER_FLOOR_USDC", "1.0"))
#: How often the background loop recomputes. A full pass is cheap off the warm
#: memos, but it is still not something to do per request.
OPS_VERIFY_S = float(os.environ.get("ACR_OPS_VERIFY_S", "900"))


class Recorder:
    """Collects one section's checks.

    ``ok=None`` is a first-class verdict and the reason this is not a bool:
    "I could not read this" is different from "this is wrong", and collapsing
    the two is how a dashboard starts lying. It renders as its own tier.
    """

    def __init__(self) -> None:
        self.sections: list[dict] = []
        self._current: dict | None = None

    def section(self, name: str, title: str) -> None:
        self._current = {"name": name, "title": title, "checks": []}
        self.sections.append(self._current)

    def check(self, ok: bool | None, label: str, *, warn_only: bool = False,
              detail: str | None = None) -> None:
        if self._current is None:
            self.section("misc", "Other")
        cur = self._current
        if cur is None:  # pragma: no cover - section() always assigns
            return
        # Coerce, because `tally()` discriminates with `is None` / `is False`.
        # A falsy non-bool — 0, "", [] — would satisfy neither branch and be
        # counted as neither pass, warning nor unknown: it would vanish from
        # the verdict while still rendering as a failure in the UI. Miscounting
        # is precisely how a dashboard starts lying.
        cur["checks"].append(
            {
                "ok": None if ok is None else bool(ok),
                "label": label,
                "detail": detail,
                # A warning is something that depends on somebody else's
                # scheduler or budget rather than on our code being correct.
                "warn": bool(warn_only),
            }
        )

    def unknown(self, label: str, why: str) -> None:
        """A read that did not land. Named, so it can never be mistaken for a
        passing check that happens to have no number attached."""
        self.check(None, label, warn_only=True, detail=why)

    def tally(self) -> tuple[int, int, int]:
        failures = warnings = unknowns = 0
        for s in self.sections:
            for c in s["checks"]:
                if c["ok"] is None:
                    unknowns += 1
                elif c["ok"] is False:
                    if c["warn"]:
                        warnings += 1
                    else:
                        failures += 1
        return failures, warnings, unknowns


def _guard(rec: Recorder, name: str, title: str, fn) -> None:
    """Run one section, converting a crash into a recorded unknown.

    Every read here can meet Arc's 429. An unguarded one would take the whole
    dashboard down with a traceback — the single worst outcome, because a page
    that 500s reads as "everything is broken" when the truth was "one RPC was
    throttled for a second".
    """
    rec.section(name, title)
    try:
        fn(rec)
    except Exception as exc:  # noqa: BLE001 — a verdict beats a traceback
        log.warning("ops section %s failed", name, exc_info=True)
        rec.unknown(f"{title.lower()} could not be read", str(exc)[:120])


# --- sections ---------------------------------------------------------------


def _oracle(rec: Recorder) -> None:
    from .onchain import get_reader

    reader = get_reader()
    if not reader.configured:
        rec.unknown("oracle configured", "no ACR_ORACLE_ADDRESS set")
        return
    prints = reader.read_all()
    rec.check(bool(prints), f"prints readable on chain ({len(prints)} index(es))")
    now = time.time()
    for iid, p in sorted(prints.items()):
        posted = float(p.get("posted_at") or p.get("timestamp") or 0)
        if not posted:
            rec.unknown(f"{iid}: print age", "no timestamp on the latest print")
            continue
        age = now - posted
        mins = age / 60
        # Two thresholds, because they mean genuinely different things: past
        # the warn line the press has missed a slot; past the hard line the
        # contract will refuse to settle against this print at all.
        rec.check(
            age <= PRINT_WARN_AGE_S if age <= PRINT_MAX_AGE_S else False,
            f"{iid}: last print {mins:.0f} min ago",
            warn_only=age <= PRINT_MAX_AGE_S,
            detail=(
                "past the settle window — the venue cannot settle against this"
                if age > PRINT_MAX_AGE_S
                else "the press posts hourly" if age > PRINT_WARN_AGE_S
                else None
            ),
        )


def _press(rec: Recorder) -> None:
    from .app import get_poster

    poster = get_poster()
    posts = getattr(poster, "last_posts", {}) or {}
    landed = [e for e in posts.values() if e.get("tx")]
    if not posts:
        rec.unknown("poster provenance", "the press has not posted this boot")
        return
    rec.check(bool(landed), f"posts landed on chain this boot: {len(landed)}")
    newest = max(landed, key=lambda e: e.get("at_wall") or 0.0) if landed else None
    if newest:
        rec.check(True, f"last tx {str(newest.get('tx'))[:18]}…",
                  detail=f"{(time.time() - float(newest.get('at_wall') or 0)) / 60:.0f} min ago")


#: How far back the cadence check reaches. 16 pages × 14000 blocks ≈ 32h at
#: Arc's measured 0.510s block time — matching scripts/print_gaps.py's own
#: default. Deliberately larger than ACR_TAPE_PAGES (4): the tape wants the
#: last few hours cheaply, this wants the worst hole in a day, and one hole is
#: the whole point. Measured cost at 24 pages was ~115s of the sweep; 16 keeps
#: a full day of reach without making the first pass after boot a two-minute
#: wait.
GAP_PAGES = int(os.environ.get("ACR_OPS_GAP_PAGES", "16"))
GAP_LIMIT = int(os.environ.get("ACR_OPS_GAP_LIMIT", "400"))


def _cadence(rec: Recorder) -> None:
    """The gap between press runs — the TAIL, not the average.

    ``make print-gaps`` measures this from a laptop and its result is a claim in
    SUBMISSION.md §5; this is the same measurement standing up on the page.

    It reports what that script reports — n / median / max / over-window —
    rather than a histogram, because ``summarize()`` has no buckets and any bin
    edges invented here would be invented evidence. The only two thresholds
    that exist in this codebase are the ones above: 90 minutes means a slot was
    missed, 120 means the venue cannot settle against the print at all.

    The average is deliberately not the check. One 216-minute hole left the
    venue unsettleable for an hour, and a healthy-looking 70-minute mean hid it
    completely — which is why the count over the window is what fails.
    """
    from acr_oracle_client.cadence import index_gaps_min, press_runs

    from .onchain import get_reader

    reader = get_reader()
    if not reader.configured:
        rec.unknown("press cadence", "no ACR_ORACLE_ADDRESS set")
        return
    # recent_posts() returns [] for BOTH "nothing on chain" and "the RPC
    # refused us". Those are different verdicts and collapsing them would let a
    # throttled read render as a clean cadence — the exact failure this module
    # exists to refuse.
    posts = reader._client.recent_posts(limit=GAP_LIMIT, pages=GAP_PAGES)
    if len(posts) < 2:
        rec.unknown("press cadence", f"fewer than two prints in reach ({len(posts)})")
        return

    runs = press_runs(posts)
    if len(runs) < 2:
        rec.unknown("press cadence", f"only {len(runs)} press run in reach")
        return
    gaps = [(runs[i][0] - runs[i - 1][0]) / 60 for i in range(1, len(runs))]
    span_h = (runs[-1][0] - runs[0][0]) / 3600
    over = [g for g in gaps if g > PRINT_MAX_AGE_S / 60]
    worst = max(gaps)

    # warn_only, deliberately. A breach that has already recovered is HISTORY,
    # and this page reports what is true now; `_oracle` above is what fails
    # when the CURRENT print is too old to settle against. Conflating them
    # would leave the headline stuck on "failed" for a day and a half after a
    # single hole, which trains an operator to ignore it. `make print-gaps` is
    # the gate and still exits 1 — a gate should be louder than a dashboard.
    rec.check(
        not over,
        f"press runs: {len(runs)} over {span_h:.1f}h, worst gap {worst:.0f} min",
        warn_only=True,
        detail=(
            f"{len(over)} gap(s) past the {PRINT_MAX_AGE_S / 60:.0f}-min settle window "
            f"— the venue could not have settled then"
            if over
            else f"median {statistics.median(gaps):.0f} min"
        ),
    )
    # Per index, because a series settles against ITS index: one pressed every
    # third run is staler than the run cadence implies.
    for iid in sorted({str(p["index_id"]) for p in posts}):
        g = index_gaps_min(posts, iid)
        if not g:
            continue
        iid_over = [x for x in g if x > PRINT_MAX_AGE_S / 60]
        rec.check(
            not iid_over,
            f"{iid}: worst gap {max(g):.0f} min",
            warn_only=True,
            detail=f"{len(iid_over)} past the settle window" if iid_over else None,
        )


def _keeper(rec: Recorder) -> None:
    from . import keeper

    st = keeper.status()
    if not st.get("enabled"):
        # Deliberately off is a configuration, not a fault. Saying "disabled"
        # rather than failing is the difference between a dashboard people
        # trust and one they learn to ignore.
        rec.check(True, "keeper disabled by configuration", detail="ACR_KEEPER=0")
        return
    for chore in ("heartbeat", "roll"):
        c = st.get(chore) or {}
        age = c.get("checked_age_s")
        if age is None:
            rec.unknown(f"{chore}: last checked", "not seen since boot")
            continue
        # The chore runs on the 60s warm loop, so anything past a few minutes
        # means the loop itself stopped — a much bigger deal than a cooldown.
        rec.check(
            age < 300,
            f"{chore}: checked {age / 60:.0f} min ago",
            warn_only=True,
            detail=str(c.get("verdict") or "on cooldown, nothing to do"),
        )


def _venue(rec: Recorder) -> None:
    from .onchain import get_futures

    fut = get_futures()
    if not fut.configured:
        rec.unknown("venue configured", "no ACR_FUTURES_ADDRESS set")
        return
    series = fut.all_series()
    if not series:
        rec.unknown("series readable", "the venue scan returned nothing")
        return
    now = time.time()
    live = [s for s in series if not s["settled"] and s["expiry_ts"] > now]
    expired_unsettled = [s for s in series if not s["settled"] and s["expiry_ts"] <= now]
    rec.check(bool(live), f"live series: {len(live)} of {len(series)}")
    for s in live:
        hrs = (s["expiry_ts"] - now) / 3600
        rec.check(
            hrs > 2,
            f"#{s['series_id']} {s['index_id']}: {hrs:.1f}h to expiry",
            warn_only=True,
            detail="a roll is due" if hrs <= 2 else None,
        )
    # Expired-and-unsettled is the one venue state a visitor actually feels:
    # the book stops and the exit stays shut until somebody rings the bell.
    for s in expired_unsettled:
        rec.check(
            False,
            f"#{s['series_id']} {s['index_id']}: expired, not settled",
            warn_only=True,
            detail="anyone may settle it: see the desk",
        )


def _tape(rec: Recorder) -> None:
    from acr_core import get_settings

    s = get_settings()
    src = s.tape_source
    # The one disclosure that has to survive a fully-live state: every other
    # badge reports CONNECTION tier, so a simulated flow under a real print
    # would otherwise read as entirely real.
    rec.check(
        src != "sim",
        f"tape source: {src}",
        warn_only=True,
        detail="estimator, signature and print are real; the flow underneath is simulated"
        if src == "sim"
        else None,
    )


def _gate(rec: Recorder) -> None:
    from .app import get_facilitator
    from .x402 import CircleFacilitator

    circle = isinstance(get_facilitator(), CircleFacilitator)
    rec.check(True, f"payment gate: {'circle' if circle else 'dev'}",
              detail=None if circle else "the dev gate accepts a mock header")


def _hedger(rec: Recorder) -> None:
    from .app import get_facilitator
    from .hedger import build_hedger_state
    from .marketplace import build_receipts
    from .onchain import get_futures

    # The ledger was never passed, so the label "chain + ledger" was half true
    # and the spend leg of the loop was invisible to the operator. Same
    # facilitator `_gate` already reaches for, resolved the same way.
    st = build_hedger_state(get_futures(), build_receipts(get_facilitator()))
    # `if not st` could never fire — build_hedger_state always returns a
    # populated dict — so the honest question is whether an agent is CONFIGURED.
    if not st.get("configured"):
        rec.unknown("hedger standing", "no agent address (ACR_HEDGER_ADDRESS or .env)")
        return
    rec.check(True, "hedger standing derived from chain + ledger")

    # This read was `st["position"]`. The payload has always said
    # `position_contracts`, so the branch was dead and /ops never once reported
    # the one number the agent exists to move. A throttled read is None and
    # stays an unknown — a zeroed position reads as a liquidated agent.
    pos, gap = st.get("position_contracts"), st.get("gap_contracts")
    if pos is None:
        rec.unknown("hedger position", "the venue would not say")
    else:
        on_target = gap is not None and abs(gap) < 0.25
        rec.check(
            on_target,
            f"position: {pos:+.3f} of {st['target_contracts']:+.3f} contracts",
            # An operator-run agent sitting behind its mandate is a schedule
            # fact, not an outage.
            warn_only=True,
            detail=None if on_target
            else (f"gap {gap:+.3f}" if gap is not None else "gap unread"),
        )

    paid = st.get("paid_queries")
    if paid is None:
        rec.unknown("hedger spend", "the receipt ledger was not read")
    else:
        rec.check(paid > 0, f"{paid} paid read(s) for {st['spent_usdc']} USDC",
                  warn_only=True)


def _funding(rec: Recorder) -> None:
    """Wallet runway. The venue's silent-outage class: a roll that fails its
    budget guard looks identical to a venue nobody rolled."""
    from acr_core import get_settings

    from .onchain import get_futures

    s = get_settings()
    fut = get_futures()
    if not fut.configured:
        rec.unknown("wallet balances", "no venue configured")
        return
    try:
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(s.arc_rpc_url, request_kwargs={"timeout": 15}))
    except Exception as exc:  # noqa: BLE001
        rec.unknown("wallet balances", f"no RPC: {str(exc)[:60]}")
        return
    from acr_oracle_client import build_role_signer

    # Resolve each role through the SAME plumbing the keeper signs with, not a
    # separately-configured address. A second source of truth for "which wallet
    # is the maker" is a dashboard that reports a healthy balance for a wallet
    # nothing actually spends from.
    for role, floor in (("maker", VENUE_WALLET_FLOOR_USDC), ("taker", TAKER_WALLET_FLOOR_USDC)):
        try:
            sg = build_role_signer(role, s)
            addr = getattr(sg, "address", "") if sg else ""
        except Exception as exc:  # noqa: BLE001
            rec.unknown(f"{role} wallet", f"signer unavailable: {str(exc)[:60]}")
            continue
        if not addr:
            rec.unknown(f"{role} wallet", "no signer configured for this role")
            continue
        try:
            # USDC is Arc's NATIVE gas token, so the wallet balance IS the
            # native balance — no ERC-20 call needed.
            bal = float(w3.from_wei(w3.eth.get_balance(w3.to_checksum_address(addr)), "ether"))
        except Exception as exc:  # noqa: BLE001
            rec.unknown(f"{role} wallet balance", str(exc)[:60])
            continue
        rec.check(
            bal >= floor,
            f"{role}: {bal:.2f} USDC",
            warn_only=True,
            detail=f"below the {floor:.2f} floor: the next roll may fail its budget guard"
            if bal < floor
            else None,
        )


SECTIONS = [
    ("oracle", "The oracle", _oracle),
    ("press", "The press", _press),
    ("cadence", "Press cadence", _cadence),
    ("keeper", "The keeper", _keeper),
    ("venue", "The venue", _venue),
    ("tape", "The tape", _tape),
    ("gate", "The paid gate", _gate),
    ("hedger", "The hedger", _hedger),
    ("funding", "Wallet runway", _funding),
]


def run_all() -> dict:
    """One full pass. Never raises — a dashboard that can take the press down
    with it is worse than no dashboard."""
    started = time.time()
    rec = Recorder()
    for name, title, fn in SECTIONS:
        _guard(rec, name, title, fn)
    failures, warnings, unknowns = rec.tally()
    return {
        "at": started,
        "duration_s": round(time.time() - started, 2),
        "sections": rec.sections,
        "failures": failures,
        "warnings": warnings,
        "unknowns": unknowns,
        # Four words, because "degraded" and "unreadable" are different operator
        # situations and one of them is not about the product at all.
        #
        # `unknowns` outranks `warnings` deliberately. It used to lose to them,
        # which meant a section that CRASHED (recorded as one unknown) plus any
        # unrelated warning rendered as a plain "degraded" — and the crash, the
        # more serious of the two, disappeared from the headline entirely. A
        # thing we could not read is not a thing we know to be merely degraded.
        "verdict": (
            "failed" if failures else
            "unread" if unknowns else
            "degraded" if warnings else "live"
        ),
    }
