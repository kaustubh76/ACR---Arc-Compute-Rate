"""Interactive "Attack the Index" run for the Terminal's Attack Lab.

``POST /demo/attack/start`` claims the single run slot and kicks a worker
thread; ``GET /demo/attack/status`` returns the state with the error series
accumulated so far, so the UI watches the attack unfold hour by hour.

The simulation itself is synchronous and fast: it runs once up front, then the
loop *replays* it one simulated hour at a time — computing each hour's ACR
estimate, naive VWAP, and true level exactly as ``attack.py``'s cached exhibit
does — pacing each step to ~2s of wall time so the exercise unfolds live. The
verdict is derived from the same series the viewer watched (honest by
construction). The cached ``attack_snapshot`` exhibit is untouched.
"""

from __future__ import annotations

import bisect
import threading
import time
from dataclasses import dataclass, field

from acr_core import get_settings, spec_for
from acr_estimator import estimate_index, naive_vwap
from acr_sim import AttackConfig, SimConfig, simulate

HOUR = 3600.0
HOURS_TOTAL = 12
ATK_FROM = 4
ATK_TO = 8
PACE_S = 2.0  # minimum wall-clock seconds per simulated hour
STEP_TIMEOUT_S = 30.0  # watchdog: a run with no progress for this long is errored


@dataclass
class AttackRun:
    state: str = "idle"  # idle | running | done | error
    params: dict | None = None
    hour: int = 0
    series: list[dict] = field(default_factory=list)
    usdc_burned: float = 0.0
    n_adversarial: int = 0
    verdict: dict | None = None
    error: str | None = None
    stepped_at: float = 0.0  # monotonic time of last progress (watchdog)


_lock = threading.Lock()
_run = AttackRun()


def status() -> dict:
    """Copy-on-read snapshot of the current run (never hands out live refs)."""
    with _lock:
        if _run.state == "running" and time.monotonic() - _run.stepped_at > STEP_TIMEOUT_S:
            _run.state = "error"
            _run.error = "attack run stalled"
        return {
            "state": _run.state,
            "params": dict(_run.params) if _run.params else None,
            "hour": _run.hour,
            "hours_total": HOURS_TOTAL,
            "series": [dict(p) for p in _run.series],
            "usdc_burned": _run.usdc_burned,
            "n_adversarial": _run.n_adversarial,
            "verdict": dict(_run.verdict) if _run.verdict else None,
            "error": _run.error,
        }


def try_start(budget_usdc: float, target_multiplier: float, seed: int) -> bool:
    """Claim the single run slot; False if a run is already in flight."""
    global _run
    with _lock:
        if _run.state == "running":
            return False
        _run = AttackRun(
            state="running",
            params={
                "budget_usdc": budget_usdc,
                "target_multiplier": target_multiplier,
                "seed": seed,
            },
            stepped_at=time.monotonic(),
        )
        return True


def execute(budget_usdc: float, target_multiplier: float, seed: int) -> None:
    """Entry point for the worker thread — surfaces failures as state, never raises."""
    try:
        _execute(budget_usdc, target_multiplier, seed)
    except Exception as exc:  # pragma: no cover - defensive
        with _lock:
            _run.state = "error"
            _run.error = str(exc)


def _execute(budget_usdc: float, target_multiplier: float, seed: int) -> None:
    settings = get_settings()
    svc = spec_for("ACR-INF").service
    res = simulate(
        SimConfig(
            seed=seed,
            horizon=HOURS_TOTAL * HOUR,
            events_per_service=HOURS_TOTAL * 2000,
            attack=AttackConfig(
                budget_usdc=budget_usdc,
                target_multiplier=target_multiplier,
                trade_notional=40.0,
                t_start=ATK_FROM * HOUR,
                t_end=ATK_TO * HOUR,
            ),
        )
    )
    events = [e for e in res.events if e.service == svc]
    adv_ts = sorted(e.ts for e in res.events if e.is_adversarial)
    n_adv = len(adv_ts)

    for h in range(HOURS_TOTAL):
        step_started = time.monotonic()
        t0, t1 = h * HOUR, (h + 1) * HOUR
        window = [e for e in events if t0 <= e.ts < t1]
        point = None
        if len(window) >= 50:
            true = res.true_window_level("ACR-INF", window)
            p, _ = estimate_index("ACR-INF", window, res.attestations, ts=t1, settings=settings)
            vwap = naive_vwap(window)
            point = {
                "hour": h,
                "true": true,
                "acr": p.value,
                "vwap": vwap,
                "acr_err_bp": 1e4 * abs(p.value - true) / true,
                "vwap_err_bp": 1e4 * abs(vwap - true) / true,
                "attack": ATK_FROM <= h < ATK_TO,
            }
        # Burn is prorated by adversarial prints landed so far — the counter
        # the viewer watches climb during the attack window.
        seen = bisect.bisect_right(adv_ts, t1)
        burned = res.usdc_attacked * (seen / n_adv) if n_adv else 0.0

        with _lock:
            if point is not None:
                _run.series.append(point)
            _run.hour = h + 1
            _run.usdc_burned = burned
            _run.n_adversarial = seen
            _run.stepped_at = time.monotonic()

        time.sleep(max(0.0, PACE_S - (time.monotonic() - step_started)))

    with _lock:
        _run.verdict = _verdict(_run.series)
        _run.state = "done"
        _run.stepped_at = time.monotonic()


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _verdict(series: list[dict]) -> dict:
    """Swing of each statistic from its pre-attack mean to its attack-window
    mean, plus peak errors — all from the series the viewer watched."""
    pre = [p for p in series if p["hour"] < ATK_FROM]
    atk = [p for p in series if p["attack"]]
    pre_vwap, atk_vwap = _mean([p["vwap"] for p in pre]), _mean([p["vwap"] for p in atk])
    pre_acr, atk_acr = _mean([p["acr"] for p in pre]), _mean([p["acr"] for p in atk])
    vwap_swing = 100.0 * (atk_vwap - pre_vwap) / pre_vwap if pre_vwap else 0.0
    acr_swing = 100.0 * (atk_acr - pre_acr) / pre_acr if pre_acr else 0.0
    return {
        "vwap_swing_pct": vwap_swing,
        "acr_swing_pct": acr_swing,
        "resistance": abs(vwap_swing) / max(0.01, abs(acr_swing)),
        "peak_vwap_err_bp": max((p["vwap_err_bp"] for p in series), default=0.0),
        "peak_acr_err_bp": max((p["acr_err_bp"] for p in series), default=0.0),
    }
