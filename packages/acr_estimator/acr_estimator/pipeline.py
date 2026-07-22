"""The estimator pipeline — one estimand, four pillars, one print.

Wires the stages in the blueprint's order (③ deconvolve, ④ clean, ⑤ robust
estimate, ⑥ hedonic, ⑦ print + bound) into a single ``ACRPrint`` per index:

    events ─► clean ─► hedonic-adjust ─► robust median (+CI)
                                     └─► volume-time bars ─► Kalman deconvolution
                                     └─► manipulation bound (Pillar 3)

Also exposes ``naive_vwap`` — the contaminated volume-weighted mean — because the
whole demo is ACR (this pipeline) standing still while naive VWAP is dragged
around by wash flow.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from acr_core import (
    ACRPrint,
    SellerAttestation,
    TapeEvent,
    get_settings,
    spec_for,
)
from scipy.stats import norm

from .bound import ManipulationBound, manipulation_bound
from .cleaning import CleaningResult, clean
from .hedonic import HedonicModel, adjust_prices
from .observation_model import ObservationModel, SmoothResult
from .robust import RobustEstimate, estimate
from .robustness import RobustnessDiagnostics, compute_robustness


@dataclass
class PrintDiagnostics:
    cleaning: CleaningResult
    hedonic: HedonicModel
    robust: RobustEstimate
    bound: ManipulationBound
    naive_vwap: float
    smoothed: SmoothResult | None
    n_raw: int
    n_clean: int
    #: Deconvolution's shrunk end-of-window log tilt and its 1σ.
    tilt: float = 0.0
    tilt_std: float = 0.0
    robustness: RobustnessDiagnostics | None = None


def naive_vwap(events: list[TapeEvent]) -> float:
    """Contaminated volume-weighted average price — the strawman baseline."""
    if not events:
        return float("nan")
    p = np.array([e.price for e in events])
    w = np.array([e.notional for e in events])
    return float(np.sum(p * w) / np.sum(w))


def _bar_series(
    events: list[TapeEvent],
    weights: np.ndarray,
    adjusted: np.ndarray,
    bar_volume: float,
    alpha: float,
) -> tuple[np.ndarray, float]:
    """Per-bar log-price observations from *cleaned* flow, for the deconvolution.

    Bars are built over the cleaned (post-cap) weights only, so zero-weight wash
    can no longer shift bar boundaries. The bar size adapts to the surviving
    volume so the smoother always sees enough observations (≥12) even when caps
    crush the cleaned weight to a few percent of raw.
    """
    from acr_core import trimmed_weighted_median, volume_time_bars

    kept = np.where(weights > 0)[0]
    if kept.size == 0:
        return np.empty(0), 1.0
    order = kept[np.argsort([events[i].ts for i in kept])]
    ts = np.array([events[i].ts for i in order])
    w = weights[order]
    pr = adjusted[order]

    total = float(w.sum())
    n_bars = int(np.clip(total / max(bar_volume, 1e-9), 12, 96))
    bar_id = volume_time_bars(ts, w, total / n_bars)
    bar_id = np.minimum(bar_id, n_bars - 1)  # fold the boundary singleton in

    obs: list[float] = []
    durations: list[float] = []
    for b in np.unique(bar_id):
        m = bar_id == b
        if w[m].sum() <= 0:  # pragma: no cover - kept weights are all > 0
            continue
        obs.append(float(np.log(trimmed_weighted_median(pr[m], w[m], alpha))))
        tb = ts[m]
        durations.append(float(tb.max() - tb.min()) + 1e-9)
    avg_dur = float(np.mean(durations)) if durations else 1.0
    return np.array(obs), avg_dur


def estimate_index(
    index_id: str,
    events: list[TapeEvent],
    attestations: list[SellerAttestation],
    ts: float | None = None,
    settings=None,
) -> tuple[ACRPrint, PrintDiagnostics]:
    """Produce one ACR print for ``index_id`` from a window of events."""
    settings = settings or get_settings()
    spec = spec_for(index_id)
    svc = spec.service
    window = [e for e in events if e.service == svc]
    if not window:
        raise ValueError(f"no events for {index_id}")
    print_ts = ts if ts is not None else max(e.settled_ts or e.ts for e in window)

    # ④ Clean.
    cr = clean(window, cluster_cap=settings.cluster_volume_cap)
    kept_idx = np.where(cr.weights > 0)[0]
    kept_events = [window[i] for i in kept_idx]
    kept_weights = cr.weights[kept_idx]

    # ⑥ Hedonic: adjust surviving prices to constant quality.
    adjusted_all, hmodel = adjust_prices(window, attestations)
    adjusted = adjusted_all[kept_idx]

    # ⑤ Robust estimate on cleaned, quality-adjusted prices.
    rob = estimate(
        adjusted,
        kept_weights,
        alpha=settings.trim_alpha,
        n_bootstrap=settings.ci_bootstrap,
        ci_level=settings.ci_level,
    )
    value = rob.value

    # ③ Deconvolve: Kalman-smooth the per-bar series. The robust median sets the
    # level and the bootstrap CI; the smoother contributes a *shrunk* end-of-
    # window displacement and its variance flows into the interval — no silent
    # widening.
    smoothed: SmoothResult | None = None
    tilt = 0.0
    sig_t = 0.0
    ci_lo, ci_hi = rob.ci_lo, rob.ci_hi
    obs, avg_bar_dur = _bar_series(
        window, cr.weights, adjusted_all, settings.bar_volume_usdc, settings.trim_alpha
    )
    if obs.size >= 4:
        k = max(1, int(round(settings.batch_interval_seconds / avg_bar_dur)))
        om = ObservationModel(batch_width=min(k, obs.size), process_var=1e-3, obs_var=2e-2)
        smoothed = om.smooth(obs)
        latent = smoothed.latent
        denom = float(np.var(latent) + smoothed.variance[-1])
        # Shrink the raw displacement toward 0 when the latent barely moved
        # relative to the smoother's posterior uncertainty.
        lam = float(np.var(latent) / denom) if denom > 0 else 0.0
        tilt = float(np.clip(lam * (smoothed.last - float(np.mean(latent))), -0.05, 0.05))
        sig_t = lam * smoothed.last_std
        z = float(norm.ppf(0.5 + settings.ci_level / 2.0))
        value = float(rob.value * np.exp(tilt))
        ci_lo = float(rob.ci_lo * np.exp(tilt - z * sig_t))
        ci_hi = float(rob.ci_hi * np.exp(tilt + z * sig_t))

    value = max(value, 1e-9)
    # value ∈ [ci_lo, ci_hi] holds by construction (a monotone shift preserves the
    # rob.ci_lo ≤ rob.value ≤ rob.ci_hi ordering); clamp only guards float error.
    ci_lo = min(ci_lo, value)
    ci_hi = max(ci_hi, value)

    # ⑦ Manipulation bound — cap-aware, on the defended distribution.
    raw_total = float(sum(e.notional for e in window))
    mb = manipulation_bound(
        adjusted,
        kept_weights,
        alpha=settings.trim_alpha,
        fee_bps=settings.usdc_fee_bps,
        fee_flat=settings.usdc_fee_flat,
        cluster_cap=settings.cluster_volume_cap,
        raw_total=raw_total,
    )

    # Per-print robustness diagnostics (methodology §4, measured).
    node_comm = {n: i for i, c in enumerate(cr.communities) for n in c}
    comm_ids = [node_comm.get(e.seller, -1) for e in kept_events]
    robustness = compute_robustness(
        adjusted, kept_weights, comm_ids,
        alpha=settings.trim_alpha, cluster_cap=settings.cluster_volume_cap,
        sybil_clusters_required=mb.sybil_clusters_required, min_identities=mb.min_identities,
    )

    print_obj = ACRPrint(
        index_id=index_id,
        ts=print_ts,
        value=value,
        ci_lo=ci_lo,
        ci_hi=ci_hi,
        attack_cost_per_bp=mb.cost_per_bp,
        n_obs=len(kept_events),
        trim_alpha=settings.trim_alpha,
    )
    diag = PrintDiagnostics(
        cleaning=cr,
        hedonic=hmodel,
        robust=rob,
        bound=mb,
        naive_vwap=naive_vwap(window),
        smoothed=smoothed,
        n_raw=len(window),
        n_clean=len(kept_events),
        tilt=tilt,
        tilt_std=sig_t,
        robustness=robustness,
    )
    return print_obj, diag


def estimate_all(
    events: list[TapeEvent],
    attestations: list[SellerAttestation],
    index_ids: tuple[str, ...] | None = None,
    ts: float | None = None,
    settings=None,
) -> dict[str, tuple[ACRPrint, PrintDiagnostics]]:
    from acr_core import ALL_INDEX_IDS

    ids = index_ids or ALL_INDEX_IDS
    out: dict[str, tuple[ACRPrint, PrintDiagnostics]] = {}
    for iid in ids:
        try:
            out[iid] = estimate_index(iid, events, attestations, ts=ts, settings=settings)
        except ValueError:
            continue
    return out
