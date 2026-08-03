#!/usr/bin/env python
"""The autonomous hedger — an agent that buys the index, then acts on it.

This is the loop the whole project exists to make possible, run end to end by
one wallet with no human in it:

    1. PAY   a real x402 nanopayment for the latest ACR-INF print
    2. READ  its own on-chain position on the futures venue
    3. DECIDE how far it is from the hedge its mandate asks for
    4. TRADE the difference on ACRFutures — a real fill on the public tape

Every other agent in this repo does one leg. The buyer pays but never acts on
what it bought; the heartbeat trades but never pays for the data it trades on.
Neither is an economic decision. This one is: the print it purchases is the
input to the position it takes, and the log says so.

## Why a Circle AGENT wallet, and not the ones the venue uses

The maker, taker and press are Circle **developer-controlled** wallets because
they run from cron and an OTP session would expire on them (docs/WALLETS.md).
This agent is the opposite case — it is the thing Circle's agent wallet was
built for: "a programmatic USDC wallet for AI agents … to pay for x402
services". So it signs through the Circle CLI and holds no exportable key:

    circle services pay <url> --address <agent> --chain ARC-TESTNET
    circle wallet execute "trade(uint256,int256)" <series> <qty> …

That also settles a question this repo had answered too broadly. The runbook
says an x402 buyer "needs a raw, exportable EOA key" because the `exact` scheme
is EIP-3009 and the facilitator `ecrecover`s it. True when OUR code signs — but
when the CLI pays, Circle signs through the agent wallet's backing EOA and
nothing is exported. Both designs are valid; this is the one with no key.

## The guardrails, and an honest note about them

Circle agent wallets support platform-enforced spending policies — per-tx,
daily, weekly and monthly caps the CLI itself refuses to exceed. They are
**mainnet-only**; the testnet chains this runs on reject them. So every limit
below is enforced by this script, which means it is only as good as this script.
That is a weaker claim than "the platform will not let it overspend" and it is
written here so nobody upgrades it in the retelling.

What is enforced:

  * a per-run USDC spend cap, passed to the CLI as `--max-amount` too, so the
    payment layer refuses independently of our arithmetic;
  * a hard position cap in contracts;
  * a gas floor — on Arc USDC *is* gas, so a wallet spent to zero cannot exit;
  * a kill switch checked before every action;
  * sizing through the desk's own ``feasible_qty``, the same clamp a reader
    gets, so the agent cannot ask for a fill the contract would revert.

A breach REFUSES rather than silently clamping. A guardrail that quietly
shrinks your order teaches you nothing; one that stops and says why is a fact
you can act on.

    uv run python scripts/hedger.py --once            # == make hedger
    HEDGER_DRY_RUN=1 uv run python scripts/hedger.py  # decide, never spend
    HEDGER_TARGET=-2 …                                # the mandate, in contracts

Exit codes: 0 = the loop ran and every decision was honoured (including a
deliberate refusal); 1 = it could not run (no wallet, no venue, chain unreadable).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field

from acr_core import get_settings
from acr_oracle_client import FuturesClient, OracleClient, select_series_for_index
from acr_oracle_client.futures import _rpc_retry, collateral_or_none

# The desk's own margin arithmetic, reused rather than re-derived — if the agent
# and the desk ever disagreed about a safe size, one of them would be lying to
# somebody about their money.
from index_api.desk import feasible_qty

AGENT_ADDRESS = os.environ.get("ACR_HEDGER_ADDRESS", "").strip()
CHAIN = os.environ.get("ACR_HEDGER_CHAIN", "ARC-TESTNET")
API = os.environ.get("ACR_API_URL", "https://acr-api-1fto.onrender.com").rstrip("/")
INDEX = os.environ.get("HEDGER_INDEX", "ACR-INF")

#: The mandate: the position, in contracts, this agent is trying to hold. A
#: compute BUYER is short the rate it pays, so it hedges by going long the
#: future — a negative target would be a seller's mandate.
TARGET = float(os.environ.get("HEDGER_TARGET", "1.0"))
#: Do not trade for less than this; a dust fill costs more in gas than it hedges.
MIN_TRADE = float(os.environ.get("HEDGER_MIN_TRADE", "0.25"))

# --- the guardrails ---------------------------------------------------------
SPEND_CAP_USDC = float(os.environ.get("HEDGER_SPEND_CAP_USDC", "0.005"))
POSITION_CAP = float(os.environ.get("HEDGER_POSITION_CAP", "3.0"))
GAS_FLOOR_USDC = float(os.environ.get("HEDGER_GAS_FLOOR_USDC", "1.0"))
COLLATERAL_USDC = float(os.environ.get("HEDGER_COLLATERAL_USDC", "2.0"))
KILL_SWITCH = os.environ.get("HEDGER_STOP", "") not in ("", "0", "false")
DRY_RUN = os.environ.get("HEDGER_DRY_RUN", "") not in ("", "0", "false")

INTERVAL_S = float(os.environ.get("HEDGER_INTERVAL", "180"))
MAX_TICKS = int(os.environ.get("HEDGER_MAX_TICKS", "3"))
CLI_TIMEOUT_S = float(os.environ.get("HEDGER_CLI_TIMEOUT_S", "180"))
LOG_PATH = os.environ.get("HEDGER_LOG_PATH", "data/hedger_decisions.jsonl")

USDC = os.environ.get("ACR_USDC_ADDRESS", "0x3600000000000000000000000000000000000000")


@dataclass
class Decision:
    """One tick, with the inputs that justified it.

    Logged whole and deliberately: "the agent traded" is an assertion, while
    "the agent held -0.75 against a target of 1.0 at a mark of 0.4953, so it
    bought 1.0" is a claim a judge can check against the chain.
    """

    at: float
    mark: float | None = None
    position: float | None = None
    target: float = TARGET
    gap: float | None = None
    intent: str = "hold"
    qty: float = 0.0
    spent_usdc: float = 0.0
    refused: str | None = None
    print_tx: str | None = None
    trade_tx: str | None = None
    notes: list[str] = field(default_factory=list)


def log_decision(d: Decision) -> None:
    line = json.dumps(asdict(d))
    print(f"  · {line}")
    try:
        path = LOG_PATH
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "a") as fh:
            fh.write(line + "\n")
    except Exception:  # noqa: BLE001 — a log that cannot write must not stop the agent
        pass


def circle(args: list[str], *, timeout: float = CLI_TIMEOUT_S) -> tuple[int, dict | None, str]:
    """Run the Circle CLI and parse its JSON. Returns ``(code, data, raw)``.

    Shelling out is the point rather than a shortcut: it means the agent signs
    with Circle's own agent tooling and never touches a key. The CLI is invoked
    through ``npx`` so a machine without a global install still works.
    """
    cmd = ["npx", "-y", "@circle-fin/cli@latest", *args, "--output", "json"]
    # --experimental-global-webcrypto is REQUIRED for `services pay`. Without it
    # the CLI dies inside Gateway batched-payment signature creation with
    # "ReferenceError: crypto is not defined" — and it says "Could not sign
    # payment authorization", which reads like a wallet or protocol problem
    # rather than a missing Node global. Measured on Node v26, where `crypto`
    # IS a global at the top level, so something in the CLI's signing path runs
    # without it. `circle wallet execute` is unaffected; only the payment leg.
    env = {
        **os.environ,
        "CIRCLE_ACCEPT_TERMS": "1",
        "NODE_OPTIONS": (
            os.environ.get("NODE_OPTIONS", "") + " --experimental-global-webcrypto"
        ).strip(),
    }
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except Exception as exc:  # noqa: BLE001 — a verdict beats a traceback
        return 1, None, f"{type(exc).__name__}: {exc}"
    raw = (p.stdout or "") + (p.stderr or "")
    # npm chatters on stderr; find the JSON rather than assuming it stands alone.
    for start in (raw.find("{"), raw.find("[")):
        if start >= 0:
            try:
                return p.returncode, json.loads(raw[start:]), raw
            except Exception:
                continue
    return p.returncode, None, raw


def _fmt_qty(q: float) -> str:
    """Contracts as the contract wants them: WAD-scaled integer, as a string.

    A float would reach the CLI in scientific notation for small sizes and be
    ABI-encoded as something nobody intended.
    """
    return str(int(round(q * 10**18)))


def buy_the_print(spent_so_far: float, d: Decision) -> float:
    """Pay for one print through the agent wallet. Returns USDC spent this call."""
    price_cap = min(SPEND_CAP_USDC - spent_so_far, SPEND_CAP_USDC)
    if price_cap <= 0:
        d.notes.append("spend cap reached — did not buy a print")
        return 0.0
    url = f"{API}/prints/{INDEX}"
    args = ["services", "pay", url, "--address", AGENT_ADDRESS, "--chain", CHAIN,
            "--max-amount", f"{price_cap:.6f}"]
    if DRY_RUN:
        args.append("--estimate")
    code, data, raw = circle(args)
    if code != 0 or data is None:
        d.notes.append(f"payment failed: {raw.strip()[:160]}")
        return 0.0
    body = data.get("data", data)
    if DRY_RUN:
        d.notes.append(f"dry run — would pay {body.get('price', '?')}")
        return 0.0
    ref = body.get("settlementRef") or body.get("transactionId") or body.get("id")
    d.print_tx = str(ref) if ref else None
    # Trust the seller's own price, not our guess at it.
    paid = float(body.get("amountPaid") or body.get("amount") or 0.0001)
    d.notes.append(f"paid {paid} USDC for {INDEX}")
    return paid


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    s = get_settings()

    if not AGENT_ADDRESS:
        print("set ACR_HEDGER_ADDRESS to the Circle agent wallet's address")
        sys.exit(1)
    if not s.futures_address:
        print("set ACR_FUTURES_ADDRESS")
        sys.exit(1)

    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(s.arc_rpc_url, request_kwargs={"timeout": 25}))
    if not w3.is_connected():
        print("Arc RPC unreachable")
        sys.exit(1)
    me = Web3.to_checksum_address(AGENT_ADDRESS)  # Circle returns lowercase
    fc = FuturesClient(rpc_url=s.arc_rpc_url, futures_address=s.futures_address)
    oracle = OracleClient(rpc_url=s.arc_rpc_url, oracle_address=s.oracle_address or None)

    print(f"hedger  agent {me} (Circle agent wallet, no exportable key)")
    print(f"        venue {s.futures_address}  index {INDEX}  target {TARGET:+.2f}")
    print(f"        caps: spend {SPEND_CAP_USDC} USDC · position {POSITION_CAP} · "
          f"gas floor {GAS_FLOOR_USDC}"
          + ("  [DRY RUN]" if DRY_RUN else ""))
    print("        note: agent-wallet spending POLICY is mainnet-only, so these "
          "caps are enforced here, not by the platform\n")

    spent = 0.0
    once = "--once" in sys.argv
    ticks = 1 if once else MAX_TICKS

    for _tick in range(1, ticks + 1):
        d = Decision(at=time.time())

        if KILL_SWITCH or os.environ.get("HEDGER_STOP", "") not in ("", "0", "false"):
            d.refused = "kill switch set (HEDGER_STOP)"
            log_decision(d)
            break

        gas = _rpc_retry(w3.eth.get_balance, me) / 1e18
        if gas < GAS_FLOOR_USDC:
            d.refused = f"gas {gas:.3f} < floor {GAS_FLOOR_USDC} — refusing to trade a wallet that could not exit"
            log_decision(d)
            break

        # 1) Buy the print. This is the input to everything below it.
        spent += buy_the_print(spent, d)
        d.spent_usdc = round(spent, 6)

        # 2) Read the venue and our own position.
        series = select_series_for_index(fc.read_all_series(), INDEX)
        if not series or series.get("settled"):
            d.refused = "no live series to hedge on"
            log_decision(d)
            break
        sid, mult = series["series_id"], series["multiplier"]
        mark = oracle.read_latest(INDEX)
        d.mark = float(mark["value"]) if mark else None
        if not d.mark:
            d.refused = "no live mark — refusing to size a trade against a guess"
            log_decision(d)
            break

        pos = fc.position_of(sid, me) or {"contracts": 0.0}
        d.position = float(pos.get("contracts", 0.0))
        mine = collateral_or_none(fc, sid, me)
        if mine is None:
            d.refused = "the chain would not say what collateral I hold — a throttled read is not an empty account"
            log_decision(d)
            break

        # 3) Decide. The gap between the mandate and reality IS the trade.
        d.gap = TARGET - d.position
        if abs(d.gap) < MIN_TRADE:
            d.intent = "hold"
            d.notes.append(f"within {MIN_TRADE} of target — nothing worth paying gas for")
            log_decision(d)
            if once:
                break
            time.sleep(INTERVAL_S)
            continue

        # A cap REFUSES; it does not quietly shrink the order.
        if abs(d.position + d.gap) > POSITION_CAP:
            d.refused = (f"target {TARGET:+.2f} would breach the position cap "
                         f"{POSITION_CAP} — refusing rather than clamping")
            log_decision(d)
            break

        # Provision BEFORE sizing. `feasible_qty` caps the trade at what this
        # wallet's own collateral can margin, so an unprovisioned agent is
        # sized to exactly zero and refuses — correct arithmetic, wrong order.
        # Collateral is per series, so this fires again after every roll.
        if mine <= 0:
            if DRY_RUN:
                d.notes.append(
                    f"no collateral on series {sid} — would post {COLLATERAL_USDC} USDC "
                    "before sizing"
                )
            else:
                for sig, params in (
                    ("approve(address,uint256)", [s.futures_address, str(2**256 - 1)]),
                    ("postCollateral(uint256,uint256)",
                     [str(sid), str(int(COLLATERAL_USDC * 1_000_000))]),
                ):
                    contract = USDC if sig.startswith("approve") else s.futures_address
                    code, _, raw = circle(["wallet", "execute", sig, *params,
                                           "--contract", contract, "--address", AGENT_ADDRESS,
                                           "--chain", CHAIN])
                    if code != 0:
                        d.refused = f"{sig.split('(')[0]} failed: {raw.strip()[:160]}"
                        log_decision(d)
                        sys.exit(1)
                    d.notes.append(f"{sig.split('(')[0]} ok")
                    time.sleep(3)
                reread = collateral_or_none(fc, sid, me)
                if reread is None or reread <= 0:
                    d.refused = "posted collateral but the venue still reads zero — refusing to trade on a guess"
                    log_decision(d)
                    break
                mine = reread
                d.notes.append(f"collateral now {mine:.2f} USDC")

        maker = Web3.to_checksum_address(series["maker"])
        maker_coll = collateral_or_none(fc, sid, maker)
        if maker_coll is None:
            d.refused = "could not read the maker's collateral — refusing to size against a guess"
            log_decision(d)
            break
        margin_bps = 2000
        try:
            margin_bps = int(_rpc_retry(
                w3.eth.contract(
                    address=Web3.to_checksum_address(s.futures_address),
                    abi=[{"type": "function", "name": "MARGIN_BPS", "stateMutability": "view",
                          "inputs": [], "outputs": [{"name": "", "type": "uint256"}]}],
                ).functions.MARGIN_BPS().call
            ))
        except Exception:
            d.notes.append("MARGIN_BPS unreadable — using the deployed default 2000")

        max_buy, max_sell = feasible_qty(
            d.mark, mult, margin_bps, mine, d.position,
            maker_coll, series.get("maker_inventory", 0.0),
        )
        want = d.gap
        room = max_buy if want > 0 else max_sell
        if room <= 0:
            d.refused = (f"the book has no room this way (max_buy {max_buy}, "
                         f"max_sell {max_sell}) — the desk's own clamp says so")
            log_decision(d)
            break
        d.qty = round(min(abs(want), room) * (1 if want > 0 else -1), 2)
        d.intent = "buy" if d.qty > 0 else "sell"

        if DRY_RUN:
            d.notes.append("dry run — decided but did not trade")
            log_decision(d)
            break

        # 4) Act, through the agent wallet. (Collateral was provisioned above,
        #    before sizing — `feasible_qty` needs it to give any room at all.)
        code, data, raw = circle(["wallet", "execute", "trade(uint256,int256)",
                                  str(sid), _fmt_qty(d.qty),
                                  "--contract", s.futures_address,
                                  "--address", AGENT_ADDRESS, "--chain", CHAIN])
        if code != 0:
            d.refused = f"trade failed: {raw.strip()[:200]}"
            log_decision(d)
            sys.exit(1)
        body = (data or {}).get("data", data or {})
        d.trade_tx = str(body.get("txHash") or body.get("id") or "")
        d.notes.append("traded through the Circle agent wallet")
        log_decision(d)

        if once:
            break
        time.sleep(INTERVAL_S)

    print(f"\nhedger: done — {spent:.6f} USDC spent on data this run")


if __name__ == "__main__":
    main()
