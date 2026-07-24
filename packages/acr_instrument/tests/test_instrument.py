"""acr_instrument tests."""

from __future__ import annotations

from acr_instrument import ACRFuture, ASParams, AvellanedaStoikovMM, Position


def test_position_pnl_on_close():
    pos = Position()
    pos.apply_fill(10, 0.50)  # long 10 @ 0.50
    pos.apply_fill(-10, 0.55)  # close @ 0.55
    assert abs(pos.realized_pnl - 10 * 0.05) < 1e-9
    assert pos.contracts == 0


def test_position_unrealized_and_settle():
    pos = Position()
    pos.apply_fill(5, 0.50)
    assert abs(pos.unrealized_pnl(0.60) - 5 * 0.10) < 1e-9
    pnl = pos.settle(0.60)
    assert abs(pnl - 5 * 0.10) < 1e-9
    assert pos.contracts == 0


def test_future_cash_settles_against_oracle():
    fut = ACRFuture(index_id="ACR-INF", expiry_ts=1000.0, multiplier=1000.0)
    pos = Position()
    pos.apply_fill(2, 0.50)  # long 2 contracts @ 0.50
    usdc = fut.cash_settle(pos, oracle_print=0.52)
    assert abs(usdc - 2 * 0.02 * 1000.0) < 1e-6  # $40


def test_as_quote_skews_against_inventory():
    mm = AvellanedaStoikovMM("ACR-INF", expiry_ts=100.0, params=ASParams(gamma=0.5, sigma=0.1))
    flat = Position(contracts=0.0)
    longp = Position(contracts=20.0)
    q_flat = mm.quote(0.50, flat, now=0.0, start=0.0)
    q_long = mm.quote(0.50, longp, now=0.0, start=0.0)
    # Holding a long, the MM lowers its quotes to shed inventory.
    assert q_long.mid < q_flat.mid
    assert q_flat.bid < q_flat.ask
    assert q_flat.spread_bp > 0


def test_as_quote_survives_extreme_inventory():
    # At huge inventory the reservation price goes deeply negative; the ask must
    # still be a valid positive price (Quote enforces bid/ask > 0), not a crash.
    mm = AvellanedaStoikovMM("ACR-INF", expiry_ts=100.0, params=ASParams(gamma=0.9, sigma=0.5))
    q = mm.quote(0.50, Position(contracts=1e6), now=0.0, start=0.0)
    assert q.bid > 0 and q.ask > 0
    assert q.ask >= q.bid
