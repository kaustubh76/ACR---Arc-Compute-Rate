"""The venue keeper's safety rules.

It shares a process with the press, so the tests that matter are the ones about
what it REFUSES to do. Hermetic: no chain, no Circle, no credentials.
"""

from __future__ import annotations

import pytest
from index_api import keeper


@pytest.fixture(autouse=True)
def _reset_cooldowns(monkeypatch):
    monkeypatch.setattr(keeper, "_last_heartbeat", 0.0)
    monkeypatch.setattr(keeper, "_last_roll_check", 0.0)
    monkeypatch.delenv("ACR_KEEPER", raising=False)


class _LocalSigner:
    """Stands in for LocalKeySigner — a raw key, which the keeper must refuse."""

    address = "0x" + "a" * 40


class CircleWalletSigner:  # noqa: N801 — the NAME is the assertion
    """Named EXACTLY like the real class, because `_custody_signer` checks
    `type(sg).__name__`. An underscore-prefixed fake silently fails that
    check and makes the refusal tests pass for the wrong reason."""

    address = "0x" + "b" * 40


def test_the_kill_switch_stops_everything(monkeypatch):
    """One env var must stand the keeper down without a deploy — the thing you
    reach for when the venue is misbehaving and the press must keep printing."""
    monkeypatch.setenv("ACR_KEEPER", "0")
    assert keeper.enabled() is False
    assert keeper.heartbeat_once(None) is None
    assert keeper.roll_if_needed(None) is None


def test_it_refuses_a_raw_key_and_does_not_fall_back(monkeypatch):
    """The whole reason this module exists. `build_role_signer` will happily
    return a LOCAL signer when a role has no Circle wallet — and some hosts have
    an ambient ACR_POSTER_PRIVATE_KEY lying around. Silently signing the venue's
    chores with it would reintroduce exactly what the migration removed."""
    monkeypatch.setattr(
        "acr_oracle_client.build_role_signer", lambda role, settings=None: _LocalSigner()
    )
    assert keeper._custody_signer("taker") is None
    assert keeper.heartbeat_once(None) is None
    assert keeper.roll_if_needed(None) is None


def test_no_signer_at_all_is_a_quiet_no_op(monkeypatch):
    """An offline or unconfigured deployment must not raise inside the press's
    warm loop."""
    monkeypatch.setattr(
        "acr_oracle_client.build_role_signer", lambda role, settings=None: None
    )
    assert keeper.heartbeat_once(None) is None


def test_custody_is_accepted(monkeypatch):
    monkeypatch.setattr(
        "acr_oracle_client.build_role_signer",
        lambda role, settings=None: CircleWalletSigner(),
    )
    assert keeper._custody_signer("maker") is not None


def test_the_cooldown_bounds_a_failing_chore(monkeypatch):
    """Without a floor, a chore that cannot succeed would be retried on every
    60-second warm tick, burning gas and RPC budget to keep failing."""
    import time

    monkeypatch.setattr(
        "acr_oracle_client.build_role_signer",
        lambda role, settings=None: CircleWalletSigner(),
    )
    monkeypatch.setattr(keeper, "_last_heartbeat", time.time())  # just ran
    assert keeper.heartbeat_once(None) is None, "it ran again inside the cooldown"
    monkeypatch.setattr(keeper, "_last_roll_check", time.time())
    assert keeper.roll_if_needed(None) is None


def test_a_chore_failure_never_costs_the_press_a_beat():
    """The isolation guarantee, checked against the code that provides it: the
    keeper's exceptions are caught INSIDE the warm loop's own handler, so a
    broken chore cannot skip the print republish that follows it."""
    import asyncio

    from index_api import app

    async def _boom(futures):
        raise RuntimeError("venue on fire")

    class _Keeper:
        enabled = staticmethod(lambda: True)
        heartbeat_once = staticmethod(lambda f: (_ for _ in ()).throw(RuntimeError("boom")))
        roll_if_needed = staticmethod(lambda f: None)

    import sys

    real = sys.modules.get("index_api.keeper")
    sys.modules["index_api.keeper"] = _Keeper  # type: ignore[assignment]
    try:
        asyncio.run(app._run_keeper(None))  # must NOT raise
    finally:
        if real is not None:
            sys.modules["index_api.keeper"] = real
