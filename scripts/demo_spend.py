#!/usr/bin/env python
"""The 3-minute demo, as a driver you can actually record.

    uv run python scripts/demo_spend.py --chain testnet            # read-only beats
    uv run python scripts/demo_spend.py --chain testnet --spend    # + real on-chain spend

WHY THIS EXISTS. A demo narrated over raw JSON fails on camera for three
reasons, each of which cost us a take: a cold Render instance puts 40 seconds of
dead air in the middle of a beat; `check_spend` returns `over_par_bp:
212222.22222222225` for a bill whose denomination is off, which reads as a units
bug rather than a finding; and a stale print invites "is this thing live?"
exactly when you cannot afford the question.

So this script does what `rehearse_demo.py` does for the pages: it refuses to
start when the surface is not fit to show, then paces the beats itself. The
numbers are rounded to what a viewer can read, every figure carries its unit,
and nothing is printed that was not just fetched.

BEAT 4 IS THE ONLY ONE THAT MOVES MONEY and it is behind `--spend`, because a
demo script that can empty a wallet by being run twice is a trap.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "acr_oracle_client"))

TERMINAL = "https://arc-compute-rate.vercel.app"
PRESS = {
    "mainnet": "https://acr-probe-free.onrender.com",
    "testnet": "https://acr-api-1fto.onrender.com",
}
RPC = {
    "mainnet": "https://rpc.mainnet.arc.io",
    "testnet": "https://rpc.testnet.arc.io",
}
#: PER CHAIN, and verified by asking each one for a real transaction rather
#: than by trusting a 200. `explorer.arc.io/tx/<testnet hash>` answers 200 with
#: an empty SPA shell -- and, from a hot IP, a Cloudflare interstitial -- so a
#: testnet link built from it shows a judge nothing. The testnet Blockscout
#: returned this demo's own spendApproved tx at block 67,693,084.
EXPLORER = {
    "mainnet": "https://explorer.arc.io",
    "testnet": "https://explorer.testnet.arc.io",
}
WALLET = {
    "mainnet": "0x3a5F444B0e4Ddc7FA6dcddA07A71d0710eea4e04",
    "testnet": "0xa67F188746f479A9d93D112BeeB7aadB90bE834b",
}
USDC = "0x3600000000000000000000000000000000000000"

#: A bill at par for 10 MB of seller data, and the same bill 20% over. The pair
#: is the whole point of beat 2: one digit changes, the verdict changes, and the
#: rule sentence says why in English. Chosen so `over_par_bp` lands on 2000 --
#: a number a viewer believes -- rather than the six-figure bp a mis-denominated
#: bill produces.
UNIT = "$/MB"
RESOURCE = "compute-acr-seller-data-small"
SELLER = "0x0721821F6E2e8B00AC5a1E3a4Ae0bE4E3b0bE4E3"
QUANTITY = 10
FAIR_USDC = 0.0009
OVER_USDC = 0.00108

#: Beat 1 will not run on a print older than this. Two hours is generous for an
#: hourly press and still lets you say "printed within the hour" honestly most
#: of the time; past it, read the age the response gives you instead.
MAX_PRINT_AGE_S = 2 * 3600


def rule(title: str = "") -> None:
    print()
    print("  " + "=" * 68)
    if title:
        print(f"   {title}")
        print("  " + "=" * 68)


def row(label: str, value: object, unit: str = "") -> None:
    print(f"   {label:<26} {value}{(' ' + unit) if unit else ''}")


def pause(auto: bool) -> None:
    if auto:
        return
    try:
        input("\n   [enter] ")
    except (EOFError, KeyboardInterrupt):
        print()
        # `from None`: a Ctrl-C at the prompt is the operator leaving, not an
        # error inside the handler, so it should not read as one in a traceback.
        raise SystemExit(0) from None


def get(url: str, timeout: int = 90) -> tuple[int, object]:
    req = urllib.request.Request(url, headers={"user-agent": "acr-demo/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(body)
            except json.JSONDecodeError:
                return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def mcp(chain: str, tool: str, args: dict, timeout: int = 90) -> dict:
    """One hosted-MCP tool call, unwrapped to the dict the tool returned."""
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    }
    req = urllib.request.Request(
        f"{TERMINAL}/api/mcp?chain={chain}",
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "user-agent": "acr-demo/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        env = json.loads(r.read().decode())
    text = env["result"]["content"][0]["text"]
    return json.loads(text)


def eth(chain: str, method: str, params: list, timeout: int = 60) -> object:
    req = urllib.request.Request(
        RPC[chain],
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json", "user-agent": "acr-demo/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


def _pad(addr: str) -> str:
    return addr.lower().replace("0x", "").rjust(64, "0")


def _sel(sig: str) -> str:
    from eth_utils import keccak

    return "0x" + keccak(text=sig)[:4].hex()


# --------------------------------------------------------------------------
# Signers. Built from the environment and passed to PolicyClient EXPLICITLY,
# because `.env` belongs to the operator and a demo must not rewrite it. The
# roles are not interchangeable: the agent holds `isAgent` and may call
# `spend`; the owner signs the EIP-712 approval that clears anything above the
# per-transaction limit.
#
# ADDRESSES ARE PRINTED, KEYS NEVER ARE.
AGENT_KEY_ENV = "ACR_POSTER_PRIVATE_KEY"
OWNER_KEY_ENV = "ACR_BUYER_PRIVATE_KEY"

#: cap, per-tx limit and period for the demo budget, in USDC. The per-tx limit
#: is 0.05 on purpose: it is the threshold the live archive actually escalated
#: against (a 0.069463 bill), so the ladder beat shows the real boundary rather
#: than one invented for the camera.
DEMO_CAP = 5.0
DEMO_PER_TX = 0.05
DEMO_PERIOD_S = 86_400


def _signers():
    from acr_oracle_client.signer import LocalKeySigner

    out = {}
    for role, env in (("agent", AGENT_KEY_ENV), ("owner", OWNER_KEY_ENV)):
        key = os.environ.get(env)
        out[role] = LocalKeySigner(key) if key else None
    return out


def _client(chain: str):
    from acr_oracle_client.policy import PolicyClient

    sg = _signers()
    return PolicyClient(
        rpc_url=RPC[chain],
        wallet_address=WALLET[chain],
        agent_signer=sg["agent"],
        owner_signer=sg["owner"],
    )


def setup_budget(chain: str, category: str) -> int:
    """Owner-only: give the category a cap so `spend` has something to spend.

    `spend()` has no `exists` check -- an unset budget has cap 0 and fails at G6
    with "over category budget", which reads like an overspend. This is what
    makes that message go away.
    """
    from eth_abi import encode
    from eth_utils import keccak
    from web3 import Web3

    rule("SETUP — setBudget (owner only, run once, not on camera)")
    sg = _signers()
    if not sg["owner"]:
        print(f"   {OWNER_KEY_ENV} is not set; cannot call an onlyOwner function.")
        return 1
    w3 = Web3(Web3.HTTPProvider(RPC[chain]))
    pw = WALLET[chain]
    onchain_owner = "0x" + w3.eth.call({"to": pw, "data": "0x8da5cb5b"}).hex()[-40:]
    row("wallet", pw)
    row("owner on chain", onchain_owner)
    row("signer", sg["owner"].address)
    if onchain_owner.lower() != sg["owner"].address.lower():
        print("   REFUSED: this signer is not the owner. setBudget would revert.")
        return 1

    cid = keccak(text=f"acr.category::{category}")
    data = "0x" + keccak(text="setBudget(bytes32,uint256,uint256,uint64)")[:4].hex() + encode(
        ["bytes32", "uint256", "uint256", "uint64"],
        [cid, int(DEMO_CAP * 1e6), int(DEMO_PER_TX * 1e6), DEMO_PERIOD_S],
    ).hex()
    row("category", f"{category}  (id 0x{cid.hex()[:16]}…)")
    row("cap / per-tx", f"{DEMO_CAP} / {DEMO_PER_TX}", "USDC")
    tx = sg["owner"].send_transaction(w3, {"to": pw, "data": data, "gas": 200_000})
    row("tx", tx)
    r = w3.eth.wait_for_transaction_receipt(tx, timeout=180)
    row("status", "ok" if r["status"] == 1 else "REVERTED")
    row("explorer", f"{EXPLORER[chain]}/tx/{tx}")
    return 0 if r["status"] == 1 else 1


# --------------------------------------------------------------------------
# beat 0 — preflight. The point is to fail HERE, not on camera.
# --------------------------------------------------------------------------
def preflight(chain: str, want_spend: bool) -> dict:
    rule("BEAT 0 — PREFLIGHT (not for the recording)")
    facts: dict = {"blocking": []}

    # Warm the press first: the free tier sleeps, and the cold call is the one
    # that would otherwise land mid-beat.
    t0 = time.time()
    code, _ = get(f"{PRESS[chain]}/health")
    warm = time.time() - t0
    row("press /health", f"http {code}  {warm:.1f}s")
    if code != 200:
        facts["blocking"].append(f"press {PRESS[chain]} answered {code}")
    elif warm > 8:
        print("      (was asleep — call it again before recording)")

    code, _ = get(f"{TERMINAL}/")
    row("terminal /", f"http {code}")
    if code != 200:
        facts["blocking"].append(f"terminal answered {code}")

    # The suspended-domain trap: a parked or suspended host answers 200.
    code, body = get("https://arccomputerate.in")
    suspended = isinstance(body, str) and "suspend" in body.lower()
    row("arccomputerate.in", f"http {code}{'  SUSPENDED — do not show' if suspended else ''}")

    try:
        tools = mcp_tools(chain)
        row("hosted MCP tools", len(tools))
        facts["tools"] = tools
        if len(tools) < 9:
            facts["blocking"].append(f"MCP exposes {len(tools)} tools, expected 9")
    except Exception as e:  # noqa: BLE001
        facts["blocking"].append(f"MCP tools/list failed: {e}")

    try:
        r = mcp(chain, "get_rate", {"index_id": "ACR-INF"})
        age = float(r.get("age_s") or 0)
        facts["print_age_s"] = age
        facts["print"] = r
        row("ACR-INF print age", f"{age/60:.0f} min  ({r.get('freshness')})")
        if age > MAX_PRINT_AGE_S:
            facts["blocking"].append(
                f"print is {age/3600:.1f}h old — do not narrate a fresh print; read the age aloud"
            )
    except Exception as e:  # noqa: BLE001
        facts["blocking"].append(f"get_rate failed: {e}")

    # The market basket behind beat 2 ages on a 30-day cliff, so `status: ok`
    # can still read "11.5 days ago" on screen. Not a fault -- it is labelled --
    # but know the number before a judge reads it off your own slide.
    try:
        probe = mcp(chain, "check_spend", {
            "seller": SELLER, "resource": RESOURCE,
            "billed_usdc": FAIR_USDC, "quantity": QUANTITY, "unit": UNIT,
        })
        ref = probe.get("reference") or {}
        bk = probe.get("basket") or {}
        facts["basket_age"] = ref.get("age")
        row("market basket", f"{ref.get('age')}  (status {bk.get('status')}, {bk.get('rows')} rows)")
        if (bk.get("age_s") or 0) > (bk.get("warn_after_s") or float("inf")):
            print("      (past its warn threshold — expect a question about it)")
    except Exception as e:  # noqa: BLE001
        row("market basket", f"unreadable ({e})")

    # Chain state for the wallet beats.
    try:
        pw = WALLET[chain]
        paused = int(eth(chain, "eth_call", [{"to": pw, "data": "0x5c975abb"}, "latest"]), 16)
        bal = int(eth(chain, "eth_call", [{"to": USDC, "data": "0x70a08231" + _pad(pw)}, "latest"]), 16) / 1e6
        facts["paused"] = bool(paused)
        facts["wallet_usdc"] = bal
        row("PolicyWallet", pw)
        row("  paused", bool(paused))
        row("  USDC balance", f"{bal:.6f}")
        if paused:
            facts["blocking"].append("wallet is paused — every spend path refuses")
        if want_spend and bal <= 0:
            facts["blocking"].append(
                f"wallet holds 0 USDC on {chain} — --spend would revert. Fund {pw} first."
            )
    except Exception as e:  # noqa: BLE001
        facts["blocking"].append(f"chain read failed: {e}")

    print()
    if facts["blocking"]:
        print("   NOT READY:")
        for b in facts["blocking"]:
            print(f"     - {b}")
    else:
        print("   ready to record.")
    return facts


def mcp_tools(chain: str) -> list[str]:
    req = urllib.request.Request(
        f"{TERMINAL}/api/mcp?chain={chain}",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "user-agent": "acr-demo/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        env = json.loads(r.read().decode())
    return [t["name"] for t in env["result"]["tools"]]


# --------------------------------------------------------------------------
def beat_price(chain: str, facts: dict) -> None:
    rule("BEAT 1 — THE PRICE IS ON CHAIN")
    print("   Nine read-only tools, one URL, zero install.\n")
    for idx in ("ACR-INF", "ACR-GPU", "ACR-DATA"):
        try:
            r = mcp(chain, "get_rate", {"index_id": idx})
        except Exception as e:  # noqa: BLE001
            row(idx, f"unavailable ({e})")
            continue
        print(f"   {idx}")
        row("  value", f"{r['value']:.6f}", "USDC")
        row("  95% CI", f"{r['ci_lo']:.6f} – {r['ci_hi']:.6f}")
        row("  attack cost / bp", f"{r['attack_cost_per_bp']:.6f}", "USDC")
        row("  printed", r.get("age"))
        row("  source", f"{r.get('source')}  oracle {r.get('oracle','')[:10]}…")
        print()


def beat_decision(chain: str) -> None:
    rule("BEAT 2 — THE DECISION, SAME SELLER, ONE DIGIT APART")
    for label, amt in (("a fair bill", FAIR_USDC), ("the same bill, +20%", OVER_USDC)):
        try:
            r = mcp(chain, "check_spend", {
                "seller": SELLER, "resource": RESOURCE,
                "billed_usdc": amt, "quantity": QUANTITY, "unit": UNIT,
            })
        except Exception as e:  # noqa: BLE001
            row(label, f"unavailable ({e})")
            continue
        # `intent` and `rule` are under `would`, NOT under `verdict`: the verdict
        # is the pricing finding, `would` is what the ladder would do about it.
        # Reading them off `verdict` prints an empty rule and an INTENT of "?",
        # which is the one thing this beat cannot afford to show.
        v = r.get("verdict") or {}
        w = r.get("would") or {}
        print(f"   {label}:  {amt} USDC for {QUANTITY} MB")
        row("  par", f"{v.get('par_usdc', 0):.6f}", f"({v.get('sellers')} observed sellers)")
        row("  over par", f"{(v.get('over_par_bp') or 0):.0f}", "bp")
        row("  INTENT", str(w.get("intent", "?")).upper())
        if w.get("recommended_intent"):
            row("  recommends", str(w["recommended_intent"]).upper())
        print(f"      rule: {w.get('rule','')}")
        print()


def beat_wallet(chain: str, facts: dict) -> None:
    rule("BEAT 3 — THE CHAIN ENFORCES IT")
    pw = WALLET[chain]
    row("contract", pw)
    row("chain", f"{chain}  (id {int(eth(chain,'eth_chainId',[]),16)})")
    row("paused", facts.get("paused"))
    row("USDC held", f"{facts.get('wallet_usdc', 0):.6f}")
    try:
        agent = os.environ.get("ACR_DEMO_AGENT_EOA", "0x1547B0d3C334F264D28B087566B512AB5CD85379")
        is_agent = int(eth(chain, "eth_call", [
            {"to": pw, "data": _sel("isAgent(address)") + _pad(agent)}, "latest"]), 16)
        row("isAgent(press EOA)", bool(is_agent))
    except Exception as e:  # noqa: BLE001
        row("isAgent", f"unreadable ({e})")
    print()
    print("   Three authorities, not interchangeable:")
    print("     spend()         agent, strict amount < perTxLimit")
    print("     spendApproved() owner EIP-712, relayed by the agent")
    print("     spendAsOwner()  because ecrecover cannot validate a Circle SCA")
    print("   paused outranks all three. It refuses; it never clamps.")


def beat_spend(chain: str, facts: dict, category: str, to: str, amount: float) -> None:
    rule("BEAT 4 — A REAL PAYMENT, ON A REAL CHAIN")
    if facts.get("wallet_usdc", 0) <= 0:
        print("   SKIPPED: the wallet holds 0 USDC, so spend() would revert.")
        print(f"   Fund {WALLET[chain]} with USDC ({USDC}) and re-run.")
        return
    from acr_oracle_client.policy import decision_hash

    pc = _client(chain)
    if not pc.configured():
        print(f"   SKIPPED: {pc.wallet_status()} — set {AGENT_KEY_ENV}.")
        return
    b = pc.budget(category) or {}
    cap = float(b.get("cap_usdc") or 0)
    if cap <= 0:
        print(f"   SKIPPED: category {category!r} has no budget (cap = 0).")
        print("   Run with --setup-budget first (owner only).")
        return
    row("category", category)
    row("cap", f"{b.get('cap_usdc')}", "USDC")
    row("spent this period", f"{b.get('spent_usdc')}", "USDC")
    row("per-tx limit", f"{b.get('per_tx_limit_usdc')}", "USDC")
    row("paying", f"{amount} USDC  ->  {to}")
    record = {
        "at": time.time(), "obligation_id": f"demo:{int(time.time())}",
        "vendor": to, "category": category, "billed_usdc": amount,
        "intent": "pay", "rule": "at par on 3 observed sellers, inside budget",
    }
    dh = "0x" + decision_hash(record).hex()
    row("decisionHash", dh)
    print("\n   The chain commits to WHY, not just how much.\n")
    tx = pc.spend(category, to, amount, record)
    row("tx", tx)
    row("explorer", f"{EXPLORER[chain]}/tx/{tx}")
    after = pc.budget(category) or {}
    row("spent now", f"{after.get('spent_usdc')}", "USDC")


def beat_ladder(chain: str, category: str, to: str) -> None:
    """Rung 2 and rung 3: the agent is refused, the owner clears it.

    The amount is deliberately ABOVE the per-transaction limit, so this is the
    boundary doing its job rather than a payment that happens to be large.
    """
    rule("BEAT 5 — ABOVE THE LIMIT: REFUSED, THEN ESCALATED")
    from acr_oracle_client.policy import decision_hash

    pc = _client(chain)
    b = pc.budget(category) or {}
    limit = float(b.get("per_tx_limit_usdc") or 0)
    if limit <= 0:
        print("   SKIPPED: no budget. Run --setup-budget first.")
        return
    amount = round(limit + 0.019463, 6)
    row("per-tx limit", f"{limit}", "USDC")
    row("this bill", f"{amount}", "USDC  (above the limit)")

    record = {
        "at": time.time(), "obligation_id": f"demo-esc:{int(time.time())}",
        "vendor": to, "category": category, "billed_usdc": amount,
        "intent": "escalate",
        "rule": f"{amount} USDC is at or above the {limit:g} per-payment limit, so the owner signs this one",
    }
    row("decisionHash", "0x" + decision_hash(record).hex())

    print("\n   [rung 1] the agent tries to pay it on its own authority …")
    try:
        pc.spend(category, to, amount, record)
        print("      UNEXPECTED: the agent was allowed to exceed its own limit.")
        return
    except Exception as e:  # noqa: BLE001
        # web3 raises the revert as a tuple whose second element is the raw
        # ABI-encoded string. Printing str(e) puts 130 characters of hex on
        # screen; the require message is the only part worth reading aloud.
        msg = str(e)
        m = re.search(r"execution reverted:?\s*([^'\")]+)", msg)
        print(f"      REFUSED by the contract: {(m.group(1).strip() if m else msg[:90])}")

    if not pc.can_escalate():
        print(f"\n   [rung 2] no owner key ({OWNER_KEY_ENV}) — would stop here and wait for a human.")
        return
    print("\n   [rung 2] the owner signs an EIP-712 approval off chain …")
    row("owner", pc.owner_signer.address)
    row("agent", pc.agent_signer.address)
    nonce_before = pc.approval_nonce()
    row("approvalNonce", nonce_before)
    # Signed and broadcast as two visible steps. `spend_approved` would sign for
    # us, but then the camera sees one call and the separation that makes the
    # threshold meaningful -- owner authorises, agent executes -- is invisible.
    deadline = pc.deadline_in(600)
    row("deadline", f"{deadline}  (+10 min)")
    vrs = pc.sign_approval(category, to, amount, record, deadline)
    row("signature v", vrs[0])
    print("      verified locally against the owner address before broadcast")
    print("\n   [rung 3] the agent relays that signature on chain …")
    tx = pc.spend_approved(category, to, amount, record, deadline, vrs=vrs)
    row("tx", tx)
    row("explorer", f"{EXPLORER[chain]}/tx/{tx}")
    row("approvalNonce now", pc.approval_nonce())
    print("      (the nonce moved, so that approval cannot be replayed)")
    print("\n   Same money, same category, a different authority — and the event")
    print("   names the agent that acted, not the owner that approved.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", choices=("mainnet", "testnet"), default="testnet")
    ap.add_argument("--spend", action="store_true", help="run beat 4: a real on-chain payment")
    ap.add_argument("--ladder", action="store_true", help="run beat 5: refused, then owner-approved")
    ap.add_argument("--setup-budget", action="store_true", help="owner-only, once: give the category a cap")
    ap.add_argument("--category", default="general")
    ap.add_argument("--to", default="0x1547B0d3C334F264D28B087566B512AB5CD85379")
    ap.add_argument("--amount", type=float, default=0.01)
    ap.add_argument("--auto", action="store_true", help="no pauses (for a dry run, not a take)")
    ap.add_argument("--beat", type=int, help="run one beat only")
    a = ap.parse_args()

    if a.setup_budget:
        return setup_budget(a.chain, a.category)

    facts = preflight(a.chain, a.spend or a.ladder)
    if facts["blocking"] and not a.auto:
        print("\n   Fix the above, or pass --auto to walk through anyway.")
        if a.beat is None:
            return 1

    beats = {1: lambda: beat_price(a.chain, facts),
             2: lambda: beat_decision(a.chain),
             3: lambda: beat_wallet(a.chain, facts)}
    if a.spend:
        beats[4] = lambda: beat_spend(a.chain, facts, a.category, a.to, a.amount)
    if a.ladder:
        beats[5] = lambda: beat_ladder(a.chain, a.category, a.to)

    chosen = [a.beat] if a.beat else sorted(beats)
    for n in chosen:
        if n not in beats:
            print(f"   no beat {n}")
            continue
        pause(a.auto)
        beats[n]()
    rule()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
