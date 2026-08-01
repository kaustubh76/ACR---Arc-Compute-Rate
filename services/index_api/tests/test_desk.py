"""Public Desk backend — hermetic tests (Circle REST + chain reads mocked).

The guardrails are the contract here: faucet caps that survive restarts,
qty clamps, and challenge payloads that encode exactly the advertised action.
"""

from __future__ import annotations

import time

import pytest
from index_api import desk
from index_api.desk import DeskError, FaucetLedger

# --- faucet ledger ---------------------------------------------------------


def test_faucet_ledger_one_drip_per_address(tmp_path):
    led = FaucetLedger(log_path=str(tmp_path / "led.jsonl"))
    led.claim("0xAbC0000000000000000000000000000000000001")
    with pytest.raises(DeskError) as e:
        led.claim("0xabc0000000000000000000000000000000000001")  # case-insensitive dup
    assert e.value.status == 409


def test_faucet_ledger_survives_restart(tmp_path):
    path = str(tmp_path / "led.jsonl")
    FaucetLedger(log_path=path).claim("0x" + "1" * 40)
    reborn = FaucetLedger(log_path=path)  # rehydrates from the JSONL
    with pytest.raises(DeskError):
        reborn.claim("0x" + "1" * 40)


def test_faucet_ledger_global_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(desk, "FAUCET_GLOBAL_CAP", 2)
    led = FaucetLedger(log_path="")
    led.claim("0x" + "1" * 40)
    led.claim("0x" + "2" * 40)
    with pytest.raises(DeskError) as e:
        led.claim("0x" + "3" * 40)
    assert e.value.status == 429


def test_faucet_release_frees_the_slot():
    led = FaucetLedger(log_path="")
    led.claim("0x" + "4" * 40)
    led.release("0x" + "4" * 40)
    led.claim("0x" + "4" * 40)  # no raise


def test_faucet_receipt_does_not_consume_a_second_slot(tmp_path):
    """The claim line reserves the slot; the receipt line records the hash. A
    restart must rehydrate ONE slot from the two lines, not two."""
    path = str(tmp_path / "led.jsonl")
    led = FaucetLedger(log_path=path)
    led.claim("0x" + "5" * 40)
    led.record_tx("0x" + "5" * 40, "0xdeadbeef")
    reborn = FaucetLedger(log_path=path)
    assert reborn.spent() == 1


def test_drip_returns_immediately_and_confirms_off_thread(monkeypatch, tmp_path):
    """The request thread must not wait on Circle's confirm poll — it outlives
    the browser's proxy timeout. The slot is reserved synchronously (the cap
    stays honest) and the hash lands later."""
    import threading

    monkeypatch.setattr(desk, "_ledger", FaucetLedger(log_path=str(tmp_path / "led.jsonl")))
    sending = threading.Event()
    release = threading.Event()

    def slow_send(address):
        sending.set()
        release.wait(5)
        return "0xfeed"

    monkeypatch.setattr(desk, "_send_stake", slow_send)
    addr = "0x" + "6" * 40
    out = desk.drip_stake(addr)
    assert out["state"] == "pending"  # returned while the transfer is in flight
    assert sending.wait(2)
    assert desk.get_ledger().spent() == 1  # slot already reserved
    release.set()
    for _ in range(50):
        if desk._drip_tx.get(addr):
            break
        time.sleep(0.05)
    assert desk._drip_tx[addr] == "0xfeed"


def test_drip_failure_frees_the_slot(monkeypatch, tmp_path):
    monkeypatch.setattr(desk, "_ledger", FaucetLedger(log_path=str(tmp_path / "led.jsonl")))

    def boom(address):
        raise RuntimeError("circle down")

    monkeypatch.setattr(desk, "_send_stake", boom)
    desk.drip_stake("0x" + "7" * 40)
    for _ in range(50):
        if desk.get_ledger().spent() == 0:
            break
        time.sleep(0.05)
    assert desk.get_ledger().spent() == 0  # the address may try again


# --- margin math -----------------------------------------------------------


def test_feasible_qty_respects_the_takers_own_margin():
    """0.5 USDC at 2000bps on a 10x index at mark 0.5 → ~1 USDC per contract,
    so the stake buys well under a contract. Quoted with the safety haircut."""
    buy, sell = desk.feasible_qty(
        mark=0.5, multiplier=10, margin_bps=2000,
        taker_collateral=0.5, taker_contracts=0.0,
        maker_collateral=100.0, maker_contracts=0.0,
    )
    assert buy == sell == round(0.90 * 0.5 / 1.0, 2)  # 0.45


def test_feasible_qty_counts_an_existing_position():
    """Margin is on the RESULTING size, so a long can add only up to the cap but
    may sell all the way through flat: 0.2 USDC/contract on 0.3 collateral caps
    |contracts| at 1.35, and the trader is already long 1."""
    buy, sell = desk.feasible_qty(
        mark=1.0, multiplier=1, margin_bps=2000,
        taker_collateral=0.3, taker_contracts=1.0,
        maker_collateral=100.0, maker_contracts=0.0,
    )
    assert buy == 0.35  # 1.35 − 1 already on
    assert sell == desk.MAX_QTY  # 1.35 + 1, clamped by the desk's own ±2


def test_feasible_qty_is_bounded_by_the_makers_margin_too():
    """Every desk fill auto-mirrors onto the maker, whose own margin check can
    revert the trade — a taker with plenty of collateral is still capped."""
    buy, sell = desk.feasible_qty(
        mark=1.0, multiplier=1, margin_bps=2000,
        taker_collateral=100.0, taker_contracts=0.0,
        maker_collateral=0.2, maker_contracts=0.0,
    )
    assert buy == sell == round(0.90 * 0.2 / 0.2, 2)  # 0.9, the maker's cap


def test_feasible_qty_never_goes_negative_or_past_the_clamp():
    buy, sell = desk.feasible_qty(
        mark=1.0, multiplier=1, margin_bps=2000,
        taker_collateral=0.0, taker_contracts=0.0,
        maker_collateral=0.0, maker_contracts=0.0,
    )
    assert (buy, sell) == (0.0, 0.0)
    big = desk.feasible_qty(
        mark=0.01, multiplier=1, margin_bps=2000,
        taker_collateral=1000.0, taker_contracts=0.0,
        maker_collateral=1000.0, maker_contracts=0.0,
    )
    assert big == (desk.MAX_QTY, desk.MAX_QTY)


# --- challenge builder -----------------------------------------------------


@pytest.fixture()
def circle_capture(monkeypatch):
    """Capture the payload build_challenge sends to Circle."""
    sent: dict = {}

    def fake_circle(method, path, body=None, user_token=None):
        sent.update({"method": method, "path": path, "body": body, "user_token": user_token})
        return {"data": {"challengeId": "ch-123"}}

    monkeypatch.setattr(desk, "_circle", fake_circle)
    monkeypatch.setattr(
        desk, "_live_series", lambda iid: {"series_id": 2, "index_id": iid, "trader_count": 3}
    )

    class _S:
        futures_address = "0x29d97c629a8278f7ec4218ab0bd8baa9182642fe"

    monkeypatch.setattr(desk, "get_settings", lambda: _S())
    return sent


def test_challenge_approve_targets_usdc_for_the_venue(circle_capture):
    out = desk.build_challenge("tok", "wid", "approve", "ACR-GPU")
    assert out == {"challenge_id": "ch-123", "action": "approve"}
    b = circle_capture["body"]
    assert circle_capture["user_token"] == "tok"
    assert b["contractAddress"] == desk.USDC_PREDEPLOY
    assert b["abiFunctionSignature"] == "approve(address,uint256)"
    assert b["abiParameters"][0] == "0x29d97c629a8278f7ec4218ab0bd8baa9182642fe"


def test_challenge_collateral_posts_the_stake_on_the_live_series(circle_capture):
    desk.build_challenge("tok", "wid", "collateral", "ACR-DATA")
    b = circle_capture["body"]
    assert b["abiFunctionSignature"] == "postCollateral(uint256,uint256)"
    assert b["abiParameters"] == ["2", "500000"]  # series 2, 0.5 USDC-6


def test_challenge_trade_clamps_and_scales_qty(circle_capture):
    desk.build_challenge("tok", "wid", "trade", "ACR-GPU", qty=7.0)  # clamped to +2
    b = circle_capture["body"]
    assert b["abiFunctionSignature"] == "trade(uint256,int256)"
    assert b["abiParameters"] == ["2", str(2 * 10**18)]

    desk.build_challenge("tok", "wid", "trade", "ACR-GPU", qty=-1.0)
    assert circle_capture["body"]["abiParameters"][1] == str(-1 * 10**18)


def test_challenge_collateral_never_posts_more_than_the_wallet_holds(circle_capture, monkeypatch):
    """If Gas Station is NOT sponsoring the SCA, the approve already burned part
    of the drip as gas (USDC is Arc's gas token) — posting the full stake would
    revert inside transferFrom. Post what's there, less this tx's own gas."""
    monkeypatch.setattr(desk, "_wallet_usdc", lambda a: 0.4993)
    desk.build_challenge("tok", "wid", "collateral", "ACR-GPU", address="0x" + "8" * 40)
    posted = int(circle_capture["body"]["abiParameters"][1])
    assert posted == int((0.4993 - desk.GAS_RESERVE_USDC) * 1_000_000)


def test_challenge_collateral_posts_the_full_stake_when_gas_is_sponsored(
    circle_capture, monkeypatch
):
    monkeypatch.setattr(desk, "_wallet_usdc", lambda a: 0.5)
    desk.build_challenge("tok", "wid", "collateral", "ACR-GPU", address="0x" + "8" * 40)
    assert circle_capture["body"]["abiParameters"][1] == "500000"


def test_challenge_trade_clamps_to_live_margin(circle_capture, monkeypatch):
    """The reader asks for 2; the venue only supports 0.45 — the challenge is
    minted at 0.45 rather than reverting after they enter their PIN."""
    monkeypatch.setattr(
        desk, "desk_limits", lambda addr, iid: {"max_buy": 0.45, "max_sell": 1.5}
    )
    desk.build_challenge("tok", "wid", "trade", "ACR-GPU", qty=2.0, address="0x" + "9" * 40)
    assert circle_capture["body"]["abiParameters"][1] == str(int(0.45 * 10**18))


def test_challenge_trade_refuses_a_direction_with_no_margin(circle_capture, monkeypatch):
    monkeypatch.setattr(desk, "desk_limits", lambda addr, iid: {"max_buy": 0.0, "max_sell": 1.5})
    with pytest.raises(DeskError) as e:
        desk.build_challenge("tok", "wid", "trade", "ACR-GPU", qty=1.0, address="0x" + "9" * 40)
    assert e.value.status == 409
    desk.build_challenge("tok", "wid", "trade", "ACR-GPU", qty=-1.0, address="0x" + "9" * 40)
    assert circle_capture["body"]["abiParameters"][1] == str(-1 * 10**18)


def test_challenge_rejects_zero_qty_and_unknown_action(circle_capture):
    with pytest.raises(DeskError) as e:
        desk.build_challenge("tok", "wid", "trade", "ACR-GPU", qty=0.0)
    assert e.value.status == 400
    with pytest.raises(DeskError):
        desk.build_challenge("tok", "wid", "withdraw", "ACR-GPU")


def test_live_series_guards(monkeypatch):
    class _Fut:
        configured = True

        def read_all(self):
            return {
                "ACR-GPU": {"series_id": 1, "settled": False, "trader_count": 127},
                "ACR-INF": {"series_id": 0, "settled": True, "trader_count": 2},
            }

    monkeypatch.setattr("index_api.onchain.get_futures", lambda: _Fut())
    with pytest.raises(DeskError) as full:
        desk._live_series("ACR-GPU")  # roster ≥ TRADER_HEADROOM
    assert full.value.status == 409
    with pytest.raises(DeskError) as settled:
        desk._live_series("ACR-INF")
    assert settled.value.status == 404
    with pytest.raises(DeskError) as missing:
        desk._live_series("ACR-DATA")
    assert missing.value.status == 404
