"""The liveness gate checks the hosted MCP server, and checks it properly.

`/api/mcp` is the URL an agent adds with no install, and until this section no
gate touched the deployed one: its unit tests stub the press, so a broken
endpoint left every check green. These tests drive `verify_hosted_mcp` with
canned replies. A reply that is wrong in each way the HTTP status cannot show
must fail, and the lists it checks must match the ones the terminal serves.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import verify_live  # noqa: E402

TESTNET_ORACLE = "0x4f00e3BDd224F4c4b4958D54cD774E84B9092609"
MAINNET_ORACLE = "0xAfe8a941957EbD3C759fEA5365fe4B75f9626D07"


def tool_result(answer: dict, *, is_error: bool = False) -> dict:
    result: dict = {"content": [{"type": "text", "text": json.dumps(answer)}]}
    if is_error:
        result["isError"] = True
    return {"jsonrpc": "2.0", "id": 1, "result": result}


def healthy(chain_id: int) -> dict:
    """What the deployed server answered on 2026-10-15, per method."""
    testnet = chain_id == verify_live.TESTNET_CHAIN_ID
    return {
        "initialize": {"result": {"serverInfo": {
            "name": "acr-tca",
            "title": f"ACR Machine TCA · hosted · {'Arc Testnet' if testnet else 'Arc'}",
        }}},
        "tools/list": {"result": {"tools": [{"name": n} for n in sorted(verify_live.HOSTED_MCP_TOOLS)]}},
        "get_rate": tool_result({
            "index_id": "ACR-INF", "value": 0.4923,
            "oracle": TESTNET_ORACLE if testnet else MAINNET_ORACLE,
        }),
        "check_spend": tool_result({"verdict": {"benchmarked": True, "verdict": "over_par"}}),
    }


@pytest.fixture()
def run(monkeypatch):
    """Run the section against canned replies; return what it failed."""

    def go(chain_id: int, replies: dict, oracle: str | None = None) -> list[str]:
        seen: list[str] = []

        def fake_post(url: str, body: dict):
            seen.append(url)
            method = body["method"]
            key = body["params"]["name"] if method == "tools/call" else method
            reply = replies[key]
            return (reply if isinstance(reply, tuple) else (200, reply))

        failures: list[str] = []
        monkeypatch.setattr(verify_live, "post", fake_post)
        monkeypatch.setattr(verify_live, "_failures", failures)
        monkeypatch.setattr(verify_live, "_warnings", [])
        testnet = chain_id == verify_live.TESTNET_CHAIN_ID
        settings = SimpleNamespace(
            arc_chain_id=chain_id,
            oracle_address=oracle if oracle is not None else (TESTNET_ORACLE if testnet else MAINNET_ORACLE),
        )
        verify_live.verify_hosted_mcp(settings)
        # Every call went to the audited chain's endpoint.
        suffix = "/api/mcp?chain=testnet" if testnet else "/api/mcp"
        assert seen and all(u.endswith(suffix) for u in seen), seen
        return failures

    return go


@pytest.mark.parametrize("chain_id", [verify_live.TESTNET_CHAIN_ID, 5042])
def test_a_healthy_server_passes_on_either_chain(run, chain_id) -> None:
    assert run(chain_id, healthy(chain_id)) == []


def test_a_testnet_url_answered_by_the_mainnet_server_fails(run) -> None:
    replies = healthy(verify_live.TESTNET_CHAIN_ID)
    replies["initialize"] = healthy(5042)["initialize"]
    failed = run(verify_live.TESTNET_CHAIN_ID, replies)
    assert len(failed) == 1 and failed[0].startswith("handshake")


def test_a_server_that_offers_a_local_only_tool_fails(run) -> None:
    replies = healthy(5042)
    replies["tools/list"]["result"]["tools"].append({"name": "pay_and_read"})
    failed = run(5042, replies)
    assert len(failed) == 1 and "OFFERS pay_and_read" in failed[0]


def test_a_missing_tool_is_named(run) -> None:
    replies = healthy(5042)
    replies["tools/list"]["result"]["tools"] = [
        t for t in replies["tools/list"]["result"]["tools"] if t["name"] != "check_spend"
    ]
    failed = run(5042, replies)
    assert len(failed) == 1 and "MISSING check_spend" in failed[0]


def test_a_print_from_the_other_chains_oracle_fails(run) -> None:
    # The label says testnet and the server is up: only the oracle address can
    # tell that the press behind it reads mainnet.
    replies = healthy(verify_live.TESTNET_CHAIN_ID)
    replies["get_rate"] = healthy(5042)["get_rate"]
    failed = run(verify_live.TESTNET_CHAIN_ID, replies)
    assert len(failed) == 1 and "reads another chain" in failed[0]


def test_an_unset_oracle_cannot_pass_the_identity_check(run) -> None:
    failed = run(5042, healthy(5042), oracle="")
    assert len(failed) == 1 and failed[0].startswith("get_rate")


@pytest.mark.parametrize("reply, said", [
    # A JSON-RPC error rides on HTTP 200.
    ({"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "press timed out"}}, "press timed out"),
    # A failed tool is a result, flagged.
    (tool_result({"detail": "boom"}, is_error=True), "tool error"),
    # A refusal the tool explains carries no isError at all.
    (tool_result({"available": False, "reason": "billed_usdc must be a number greater than zero."}), "refused"),
    # Benchmarked is the whole point of the flagship tool.
    (tool_result({"verdict": {"benchmarked": False, "reason": "no sellers"}}), "not benchmarked"),
])
def test_check_spend_failures_that_look_like_success_fail(run, reply, said) -> None:
    replies = healthy(5042)
    replies["check_spend"] = reply
    failed = run(5042, replies)
    assert len(failed) == 1 and failed[0].startswith("check_spend") and said in failed[0]


def test_an_unreachable_server_fails_every_check(run) -> None:
    down = {k: (0, None) for k in ("initialize", "tools/list", "get_rate", "check_spend")}
    assert len(run(5042, down)) == 4


def test_tool_answer_reads_text_content_only() -> None:
    answer, why = verify_live.tool_answer({"result": {"content": [
        {"type": "image", "data": "…"},
        {"type": "text", "text": json.dumps({"value": 1})},
    ]}})
    assert answer == {"value": 1} and why == ""
    assert verify_live.tool_answer({"result": {"content": [{"type": "text", "text": "[1]"}]}})[0] is None
    assert verify_live.tool_answer(None)[1].startswith("no result")


# --- the gate's lists are the terminal's lists --------------------------------

PLAYGROUND = ROOT / "apps" / "terminal" / "lib" / "mcpPlayground.ts"


def _ts_block(name: str) -> str:
    source = PLAYGROUND.read_text(encoding="utf-8")
    m = re.search(rf"export const {name}\b[^=]*=\s*([\[{{].*?[\]}}])\s*(?:as const)?;", source, re.S)
    assert m, f"{name} not found in {PLAYGROUND.name}"
    return m.group(1)


def test_the_hosted_tools_match_the_terminals_list() -> None:
    assert set(re.findall(r'"(\w+)"', _ts_block("HOSTED_TOOLS"))) == set(verify_live.HOSTED_MCP_TOOLS)


def test_the_local_only_tools_match_the_terminals_list() -> None:
    assert set(re.findall(r"^\s*(\w+):", _ts_block("LOCAL_ONLY"), re.M)) == set(verify_live.HOSTED_MCP_LOCAL_ONLY)


def test_the_example_bill_is_the_one_developers_runs() -> None:
    block = _ts_block("EXAMPLE_BILL")
    unit = re.search(r'unit:\s*"([^"]+)"', block).group(1)
    billed = float(re.search(r"billed:\s*([\d.]+)", block).group(1))
    quantity = float(re.search(r"quantity:\s*([\d.]+)", block).group(1))
    assert verify_live.HOSTED_MCP_BILL == {"unit": unit, "billed_usdc": billed, "quantity": quantity}
