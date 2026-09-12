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
