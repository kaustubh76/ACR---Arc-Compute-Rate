"""Avellaneda–Stoikov market maker for the ACR future.

Mission Control quotes the weekly future live in the demo. The A–S model sets a
*reservation price* that skews away from the mid as inventory builds (so the MM
naturally mean-reverts its position) and an optimal spread that trades off the
fill rate against inventory risk:

    r(s, q) = s − q · γ · σ² · (T − t)                       (reservation price)
    δ_a + δ_b = γ · σ² · (T − t) + (2/γ) · ln(1 + γ/κ)       (optimal spread)

with s the mid (the ACR oracle print), q inventory, γ risk aversion, σ index
volatility, κ order-book liquidity, and (T−t) time to expiry. Seeding this
quoting is how ACR bootstraps its own term structure rather than waiting for
liquidity to appear.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from acr_core import Quote, get_settings

from .future import Position


@dataclass
class ASParams:
    gamma: float = 0.1  # inventory risk aversion
    kappa: float = 1.5  # order-book liquidity
    sigma: float = 0.02  # index volatility (per unit time)
    horizon: float = 1.0  # normalized time-to-expiry at t=0


class AvellanedaStoikovMM:
    def __init__(self, index_id: str, expiry_ts: float, params: ASParams | None = None) -> None:
        self.index_id = index_id
        self.expiry_ts = expiry_ts
        if params is None:
            s = get_settings()
            params = ASParams(gamma=s.as_gamma, kappa=s.as_kappa)
        self.p = params

    def _time_left(self, now: float, start: float) -> float:
        total = max(self.expiry_ts - start, 1e-9)
        return max(0.0, (self.expiry_ts - now) / total) * self.p.horizon

    def reservation_price(self, mid: float, inventory: float, tau: float) -> float:
        return mid - inventory * self.p.gamma * self.p.sigma**2 * tau

    def optimal_half_spread(self, tau: float) -> float:
        inv_risk = self.p.gamma * self.p.sigma**2 * tau
        book = (2.0 / self.p.gamma) * math.log(1.0 + self.p.gamma / self.p.kappa)
        return 0.5 * (inv_risk + book)

    def quote(
        self,
        mid: float,
        position: Position,
        now: float,
        start: float,
        size: float = 1.0,
    ) -> Quote:
        """Produce a two-sided quote around the oracle print ``mid``."""
        tau = self._time_left(now, start)
        r = self.reservation_price(mid, position.contracts, tau)
        half = self.optimal_half_spread(tau) * mid  # scale spread to price level
        bid = max(1e-9, r - half)
        # Clamp the ask above the bid too: at large inventory the reservation
        # price can go deeply negative, and Quote enforces ask > 0 (Field(gt=0)).
        ask = max(r + half, bid + 1e-9)
        return Quote(
            index_id=self.index_id,
            expiry_ts=self.expiry_ts,
            bid=bid,
            ask=ask,
            bid_size=size,
            ask_size=size,
            ts=now,
        )
