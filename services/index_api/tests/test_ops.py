"""The operator console — the sections it renders, and that it cannot raise.

`/ops` is the one surface an operator opens when something smells wrong, so the
contract is narrow and strict: every section reports, nothing throws, and a read
that did not land renders as its own tier rather than as a passing check with no
number attached.
"""

from __future__ import annotations


def test_the_console_reports_the_agent_gate_and_the_screen():
    """`_gate` answers "who takes the money" and says nothing about who is CALLING
    or what inspects what they send. While those were the same section, a screen with
    no call sites was invisible to the one surface an operator actually opens."""
    from index_api.ops import SECTIONS, run_all

    assert "agent" in {name for name, _title, _fn in SECTIONS}

    out = run_all()
    agent = next((s for s in out["sections"] if s["name"] == "agent"), None)
    assert agent is not None, "the agent section did not render"
    labels = " ".join(c["label"] for c in agent["checks"])
    assert "audience:" in labels
    assert "screen backend:" in labels, "the backend is the one thing a reader cannot infer"
    assert "inspections:" in labels
    # Never raises: a console that can take the press down with it is worse than no
    # console, which is why `_guard` exists and why this asserts a shape not a value.
    assert all(c["ok"] in (True, False, None) for c in agent["checks"])


def test_the_press_wallet_is_watched_with_a_hard_floor(monkeypatch):
    """On 2026-09-12 the press wallet — which signs EVERY on-chain write — ran to
    0.006 USDC while the console did not look at it and the verifier only warned.
    Two things are pinned here: the wallet appears in the funding section at all,
    and its floor is a FAILURE rather than a warning, because a wallet that cannot
    pay gas is not "degraded" — it is every pillar stopping within the hour."""
    from index_api import ops
    from index_api.ops import Recorder

    class _Signer:
        address = "0x8366968f84a343CF70941EBe858428643d825cb0"

    class _Eth:
        def get_balance(self, _addr):
            return int(0.25 * 1e18)  # well below the 1.0 floor

    class _W3:
        """Stands in for the CLASS, because `_funding` calls `Web3.HTTPProvider(...)`
        before it ever constructs an instance — a bare factory lambda here reports
        "no RPC" and the section bails before reaching the wallet."""

        eth = _Eth()

        def __init__(self, *_a, **_k):
            pass

        @staticmethod
        def HTTPProvider(*_a, **_k):  # noqa: N802 - mirrors web3's name
            return object()

        @staticmethod
        def to_checksum_address(a):
            return a

        @staticmethod
        def from_wei(v, _unit):
            return v / 1e18

    import web3

    monkeypatch.setattr(web3, "Web3", _W3)
    import acr_oracle_client

    monkeypatch.setattr(acr_oracle_client, "build_role_signer",
                        lambda role, s=None: _Signer() if role == "poster" else None)

    rec = Recorder()
    rec.section("funding", "Wallet runway")
    ops._funding(rec)
    press = [c for c in rec.sections[0]["checks"] if c["label"].startswith("press:")]
    assert press, "the press wallet must appear in the funding section"
    c = press[0]
    assert c["ok"] is False, "0.25 USDC is below the critical floor and must FAIL"
    assert c["warn"] is False, "the floor is a failure, not a warning — that was the whole bug"
    assert "critical floor" in (c["detail"] or "")


def test_the_console_fails_when_the_rotation_window_has_no_humans(monkeypatch):
    """At 00:00 UTC on the boundary every resolution expires at once and only a
    manual chore brings them back. The one surface an operator opens must go RED
    then — not warn, and not leave it to a chip saying "out of date"."""
    from index_api import ops, tca
    from index_api.ops import Recorder

    monkeypatch.setattr(tca, "_cfg", lambda: ("https://example.invalid", ""))
    monkeypatch.setattr(tca, "graph_query", lambda *a, **k: {"humanClusters": []})
    def _only(rec):
        (sec,) = rec.sections
        (c,) = sec["checks"]
        return c

    rec = Recorder()
    ops._humans_this_window(rec, 2959)
    c = _only(rec)
    assert c["ok"] is False and "0 cluster(s)" in c["label"] and "resolve-humans" in c["detail"]

    monkeypatch.setattr(tca, "graph_query", lambda *a, **k: {"humanClusters": [{"id": "0x1", "walletCount": 3}, {"id": "0x2", "walletCount": 1}]})
    rec = Recorder()
    ops._humans_this_window(rec, 2959)
    c = _only(rec)
    assert c["ok"] is True and "2 cluster(s), 4 wallet(s)" in c["label"]

    # No subgraph: unknown, never a false pass.
    monkeypatch.setattr(tca, "_cfg", lambda: ("", ""))
    rec = Recorder()
    ops._humans_this_window(rec, 2959)
    assert _only(rec)["ok"] is None
