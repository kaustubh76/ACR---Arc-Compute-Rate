"""Public Desk backend — hermetic tests (Circle REST + chain reads mocked).

The guardrails are the contract here: faucet caps that survive restarts,
qty clamps, and challenge payloads that encode exactly the advertised action.
"""

from __future__ import annotations

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
