#!/usr/bin/env python
"""Generate the Terminal's bundled fallback snapshot from the real pipeline.

    uv run python scripts/gen_snapshot.py

Writes apps/terminal/lib/fallback.json so the Terminal renders real ACR output
offline (no API required). Alongside the /terminal/data payload it embeds the
marketplace catalog + a sim-labeled settlement ledger, the /revenue and
/x402/info shapes, and a recorded two-act x402 exchange — each built by the
SAME builder its live endpoint uses, so the offline bundle can never drift.
"""

from __future__ import annotations

import asyncio
import json
import os
import types
from pathlib import Path

from acr_core import get_settings
from acr_sim import AttackConfig, SimConfig
from acr_tape import SimSource
from fastapi import Response
from index_api.app import build_terminal_payload, revenue, x402_info
from index_api.marketplace import build_catalog, build_sim_receipts
from index_api.onchain import get_futures, get_reader
from index_api.store import PrintStore
from index_api.x402 import DevFacilitator

#: Warm-up refreshes before the snapshot is taken. Deep enough that the offline
#: edition ships real sparklines (24h on the home page), a history chart with
#: body on the index-detail pages, and non-degenerate realized vol.
WARMUP_REFRESHES = 48
HOUR = 3600.0
#: The persistent Arc testnet — the only chain whose oracle data may be committed.
ARC_TESTNET_CHAIN_ID = 5042002
#: Ephemeral local chains (anvil/hardhat) — never committable.
LOCAL_CHAIN_IDS = {31337, 1337}


def build_warmup_store() -> PrintStore:
    """The snapshot store: the default sim tape with a wash-flow attack pinned
    on the FINAL warm-up window (cursor 48 wraps to hour 23 of the 24h tape) —
    the same ``AttackConfig`` the eval harness and Attack Lab inject. The bundled
    seller scores / clean_share then show the cleaning stack actually catching
    sybils instead of 20 identical 1.000 rows."""
    attack = AttackConfig(
        budget_usdc=6000.0, target_multiplier=2.5, trade_notional=40.0,
        t_start=23 * HOUR, t_end=24 * HOUR,
    )
    return PrintStore(
        source=SimSource(config=SimConfig(events_per_service=24_000, attack=attack))
    )


def record_x402_exchange() -> dict:
    """The two-act x402 exchange (402 challenge → paid retry), recorded by
    exercising the REAL ``DevFacilitator`` challenge/process code paths
    in-process — never hand-written dicts, so the sample cannot drift from
    ``x402.py``."""
    s = get_settings()
    fac = DevFacilitator()
    # Resource base "" like the bundled catalog — the offline bundle is host-less.
    req = types.SimpleNamespace(base_url="", url=types.SimpleNamespace(path="/prints"))
    ch = fac.challenge(req)  # Act 1 — the 402 (spec-shaped body + b64 header)
    payer = build_sim_receipts(n=1, settings=s)["receipts"][0]["payer"]
    resp = Response()
    receipt = asyncio.run(fac.process(req, f"x402 {payer}:{s.x402_price_usdc}", resp))
    confirmation = {
        k.upper(): v for k, v in resp.headers.items()
        if k.lower().endswith("payment-response")
    }
    return {
        "challenge": {"status": ch.status_code, "headers": dict(ch.headers), "body": ch.body},
        "settled": {
            "status": 200,
            "payer": receipt.payer,
            "headers": confirmation,
            "body_note": "prints payload served",
        },
    }


def capture_futures_trades() -> list[dict]:
    """Real on-chain fills for the archived tape, read straight from ACRFutures
    at snapshot time (every call is ``_rpc_retry``-wrapped inside the reader).
    Hermetic when no venue is configured: instantly ``[]``, no network — the
    key is still embedded so the drift test enforces it."""
    try:
        return get_futures().recent_trades(use_cache=False)
    except Exception:
        return []


#: Real Circle Gateway settlements, captured by the live buyer loop.
LIVE_RECEIPTS = Path("data/x402_receipts_live.jsonl")


def _merge_live_receipts(ledger: dict) -> dict:
    """Put the REAL Gateway settlements at the head of the archived ledger.

    The bundle used to be entirely ``sim-N`` rows while two genuine Circle
    Gateway settlements sat unused on disk — so the tier a visitor sees when
    everything else is down carried no evidence that x402 had ever settled for
    real, which it demonstrably had. Two real settlements are better evidence
    than twenty-four invented ones, and we already own them.

    They stay distinguishable rather than blended: a real row keeps its
    ``scheme: "exact"`` and its Gateway UUID, which is exactly how the Terminal
    decides to deep-link a ref instead of rendering it plain. ``settled_at`` is
    dropped on purpose — a committed wall-clock is what makes an archived
    bundle look stale, and ``tests/test_snapshot_bundle.py`` guards against it.

    A missing file is normal (a fresh clone has never run the buyer), so the
    snapshot still builds fully-simulated rather than failing.
    """
    if not LIVE_RECEIPTS.exists():
        return ledger
    real: list[dict] = []
    for line in LIVE_RECEIPTS.read_text().splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not r.get("tx_ref"):
            continue
        real.append({
            "payer": r["payer"],
            "amount_usdc": r["amount_usdc"],
            "tx_ref": r["tx_ref"],
            "network": r.get("network", ""),
            "scheme": r.get("scheme", "exact"),
        })
    if not real:
        return ledger
    real.reverse()  # newest first, like the live ledger
    rows = real + list(ledger["receipts"])
    # Renumber so `seq` stays a monotone ordinal over the whole ledger.
    n = len(rows)
    for i, row in enumerate(rows):
        row["seq"] = n - i
    price = ledger["price_usdc"]
    return {
        **ledger,
        "receipts": rows,
        "paid_queries": n,
        # Sum the rows rather than multiply by price: the real settlements were
        # paid at whatever the price was THEN, and inventing agreement with
        # today's price would be the same class of lie this is fixing.
        "revenue_usdc": round(sum(r["amount_usdc"] for r in rows), 6),
        "price_usdc": price,
        "real_settlements": len(real),
    }


def embed_bundle_sections(payload: dict) -> dict:
    """Embed the crypto-rich offline sections alongside the terminal payload.

    Every section reuses its live endpoint's builder (``build_catalog``,
    ``revenue``, ``x402_info``); the ledger rows are ``build_sim_receipts``
    (honestly labeled sim by scheme + tx_ref prefix), with any REAL Gateway
    settlements from the live buyer loop merged in at the head.
    """
    sim_ledger = _merge_live_receipts(build_sim_receipts())
    payload["marketplace"] = {
        "catalog": build_catalog(""),  # resource base "" — host-less offline bundle
        "receipts": sim_ledger,
    }
    # /revenue shape with counters that AGREE with the embedded sim ledger —
    # the offline /developers page must never show $0 above a table of paid
    # receipts. The recent ring carries the first 5 rows, oldest first like live.
    rev = revenue(fac=DevFacilitator())
    rev["paid_queries"] = sim_ledger["paid_queries"]
    rev["revenue_usdc"] = sim_ledger["revenue_usdc"]
    rev["note"] = "sim ledger — archived edition"
    rev["recent"] = [
        {"payer": r["payer"], "amount_usdc": r["amount_usdc"], "tx_ref": r["tx_ref"]}
        for r in build_sim_receipts(n=5)["receipts"][::-1]
    ]
    payload["revenue"] = rev
    payload["x402"] = x402_info(fac=DevFacilitator())  # the dev gate descriptor
    payload["x402_exchange_sample"] = record_x402_exchange()
    # The archived futures tape — real fills; [] when no venue is configured.
    payload["futures_trades"] = capture_futures_trades()
    # The hedger's standing, so the archived edition shows the autonomous agent
    # rather than an empty panel. Real on-chain state when a venue and an agent
    # address are configured; an honest `configured: false` otherwise, which is
    # exactly what the panel renders as "no robot trader is switched on here".
    payload["hedger"] = capture_hedger_state()
    return payload


def capture_hedger_state() -> dict:
    """The autonomous hedger's live standing for the offline bundle."""
    from index_api.hedger import build_hedger_state
    from index_api.onchain import get_futures

    try:
        # Spend comes from the DURABLE receipts archive — the same committed
        # file SUBMISSION.md cites — never the live facilitator's counters
        # (ephemeral under an "archived" label) and never the sim ledger,
        # which knows no real payer and turned the agent's 4 real settlements
        # into a confident "paid 0". An archive the repo already version-
        # controls is exactly what an archived edition should carry.
        arch = Path("services/index_api/index_api/receipts_live.jsonl")
        rows = []
        if arch.exists():
            rows = [json.loads(ln) for ln in arch.read_text().splitlines() if ln.strip()]
        receipts = {"receipts": rows} if rows else None  # None → unknown, not 0
        return build_hedger_state(get_futures(), receipts)
    except Exception:  # pragma: no cover - a dead RPC must not fail the snapshot
        # Same key set build_hedger_state promises — pinned by
        # services/index_api/tests/test_hedger.py::test_the_payload_key_set_is_the_contract.
        return {"configured": False, "agent": None, "payer": None,
                "index_id": "ACR-INF", "target_contracts": 0.0, "venue": None,
                "wallet_kind": "circle-agent-wallet", "series_id": None,
                "multiplier": None, "mark": None, "mark_block": None,
                "position_contracts": None, "gap_contracts": None,
                "collateral_usdc": None, "paid_queries": None,
                "spent_usdc": None, "fills": [], "receipts": None}


def capture_poster_provenance(reader) -> tuple[dict | None, str | None]:
    """The newest ``PricePosted`` event per index — REAL committed txs, so the
    archived OracleProvenance panel shows genuine settlement provenance instead
    of a permanent "awaiting first live post". Reuses ``OracleClient.recent_posts``
    (the same reader the press uses to re-hydrate provenance after a cold
    start). Best-effort: any failure returns ``(None, None)`` and the payload
    keeps its honest nulls."""
    try:
        posts = reader._client.recent_posts()
        if not posts:
            return None, None
        last = {
            ev["index_id"]: {"tx": ev["tx"], "block": ev["block"], "at_wall": ev["at_wall"]}
            for ev in posts  # chronological — the newest per index wins
        }
        return {"posts": len(posts), "last": last}, posts[-1]["signer"]
    except Exception:
        return None, None


def _connected_chain_id(reader) -> int | None:
    """The chain id the reader's RPC actually answers with (None if unreachable)."""
    try:
        w3 = reader._client._connect()
        return int(w3.eth.chain_id) if w3 is not None else None
    except Exception:
        return None


def check_oracle_commit_guard(chain_id: int | None) -> None:
    """Refuse to embed oracle data unless the connected chain is the persistent
    Arc testnet. Local chains (anvil/hardhat) are ephemeral — a stale address
    makes the offline Terminal show a false "on-chain ✓" badge — and an
    unreachable RPC (None) cannot prove persistence either."""
    if chain_id != ARC_TESTNET_CHAIN_ID:
        kind = "an ephemeral local chain" if chain_id in LOCAL_CHAIN_IDS else f"chain {chain_id}"
        raise SystemExit(
            f"refusing to embed oracle data from {kind} — only the persistent "
            f"Arc testnet ({ARC_TESTNET_CHAIN_ID}) may be committed"
        )


def check_futures_commit_guard(payload: dict) -> None:
    """Refuse to commit a bundle whose futures sections are empty.

    ``capture_futures_trades`` swallows every exception and returns ``[]``, and
    ``build_terminal_payload`` emits ``{}`` for ``futures`` when no venue is
    configured — so a run without ``ACR_FUTURES_ADDRESS``, or against a
    throttled Arc RPC, writes a SYNTACTICALLY PERFECT bundle with the desk, the
    tape and the archived book silently deleted. Nothing downstream notices:
    ``tests/test_snapshot_bundle.py`` checks those keys for presence only, so CI
    stays green while the offline terminal loses the whole pillar.

    Same shape and same reason as ``check_oracle_commit_guard`` — an empty
    section is indistinguishable from a venue that does not exist, and only the
    generator is in a position to tell the difference.

    Opt out with ACR_SNAPSHOT_ALLOW_NO_FUTURES=1 for a deliberately venue-less
    bundle, so the guard is a refusal rather than an obstacle.
    """
    if os.environ.get("ACR_SNAPSHOT_ALLOW_NO_FUTURES", "") not in ("", "0", "false"):
        return
    desks = payload.get("futures") or {}
    trades = payload.get("futures_trades") or []
    if not desks:
        raise SystemExit(
            "refusing to commit a bundle with no futures desks — set "
            "ACR_FUTURES_ADDRESS (and check the RPC), or pass "
            "ACR_SNAPSHOT_ALLOW_NO_FUTURES=1 if that is really intended"
        )
    if not trades:
        raise SystemExit(
            "refusing to commit a bundle with an empty futures tape — the archived "
            "edition would show a venue that has never traded; re-run when the "
            "RPC answers, or pass ACR_SNAPSHOT_ALLOW_NO_FUTURES=1"
        )


def check_hedger_commit_guard(payload: dict) -> None:
    """Refuse to commit a bundle whose autonomous agent is missing.

    The futures guard's failure one layer up. ``build_hedger_state`` reports
    ``configured: false`` with every standing null whenever the agent address is
    unset, and ``capture_hedger_state`` swallows every exception into that same
    shape — so a run without the two addresses writes a SYNTACTICALLY PERFECT
    bundle from which the product's protagonist has been deleted.

    Not hypothetical: the committed bundle read ``configured: false`` beside a
    live venue address, because ``venue`` resolved through ACRSettings (which
    reads ``.env``) while the two agent addresses were read from raw os.environ
    and nobody had exported them. docs/SHIP-CHECKLIST.md made exporting them a
    ritual, and a ritual is not a guard. The addresses now also resolve from
    ``.env`` (acr_core.config), so the ordinary path works unattended; this
    guard is about the extraordinary one.

    Opt out with ACR_SNAPSHOT_ALLOW_NO_HEDGER=1 for a deliberately agent-less
    bundle, so the guard is a refusal rather than an obstacle.
    """
    if os.environ.get("ACR_SNAPSHOT_ALLOW_NO_HEDGER", "") not in ("", "0", "false"):
        return
    h = payload.get("hedger") or {}
    if not h.get("configured"):
        raise SystemExit(
            "refusing to commit a bundle with an unconfigured hedger — the "
            "archived edition would lose the one agent here that makes an "
            "economic decision; set ACR_HEDGER_ADDRESS and ACR_HEDGER_PAYER "
            "(both are public, and both are in .env and render.yaml), or pass "
            "ACR_SNAPSHOT_ALLOW_NO_HEDGER=1"
        )
    if not h.get("payer"):
        raise SystemExit(
            "refusing to commit a hedger with no payer — two addresses are one "
            "agent, and without ACR_HEDGER_PAYER the panel shows a machine that "
            "trades and never pays, which is the exact claim this product does "
            "NOT make; set it, or pass ACR_SNAPSHOT_ALLOW_NO_HEDGER=1"
        )
    if h.get("position_contracts") is None:
        raise SystemExit(
            "refusing to commit a hedger whose position would not read — the "
            "archived panel would print an ellipsis where its headline figure "
            "goes, forever; re-run when the RPC answers, or pass "
            "ACR_SNAPSHOT_ALLOW_NO_HEDGER=1"
        )
    if not h.get("receipts"):
        raise SystemExit(
            "refusing to commit a hedger with no purchases — the panel argues "
            "that the print it bought is the input to the position it took, and "
            "half of that would be missing; check that "
            "services/index_api/index_api/receipts_live.jsonl carries rows for "
            "ACR_HEDGER_PAYER, or pass ACR_SNAPSHOT_ALLOW_NO_HEDGER=1"
        )


def main() -> None:
    store = build_warmup_store()
    for _ in range(WARMUP_REFRESHES):
        store.refresh()
    # The payload is built by the exact function that serves /terminal/data, so
    # the committed snapshot can never drift from the live endpoint. On-chain
    # provenance rides along only when an oracle is configured
    # (ACR_ORACLE_ADDRESS) AND the connected chain is the persistent Arc
    # testnet — local chains (anvil/hardhat) are ephemeral and a stale address
    # makes the offline Terminal show a false "on-chain ✓" badge.
    reader = get_reader()
    configured = bool(get_settings().oracle_address)
    # Seed the term-structure skew from the live on-chain maker book — the
    # exact wiring the running app does before every curve (app.py). Without
    # it the A-S quoter prices a flat book and every bundled corridor is an
    # identical degenerate spread.
    futures = get_futures()
    if futures.configured:
        try:
            store.set_maker_inventory(futures.maker_inventory(use_cache=False))
        except Exception:
            pass  # best-effort — a flat skew is survivable, a crash is not
    payload = build_terminal_payload(store, reader)
    if configured:
        check_oracle_commit_guard(_connected_chain_id(reader))
        # Real postPrint provenance off the PricePosted event log — only ever
        # captured behind the commit guard (same rule as the oracle data).
        poster, signer = capture_poster_provenance(reader)
        if poster:
            payload["chain"]["poster"] = poster
            payload["chain"]["signer"] = signer
    else:
        assert payload["oracle"] is None
        assert all(p["onchain"] is None for p in payload["prints"].values())
    embed_bundle_sections(payload)
    # Both content guards answer the same question — is this archive worth
    # committing? — so they stand together.
    check_futures_commit_guard(payload)
    check_hedger_commit_guard(payload)
    out = Path("apps/terminal/lib/fallback.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2))
    hedge = payload.get("hedger") or {}
    print(
        f"wrote {out} ({out.stat().st_size:,} bytes)  "
        f"oracle={'set' if configured else 'null'}  "
        # Say it out loud: a run that quietly dropped the agent used to look
        # exactly like one that kept it.
        f"hedger={'set' if hedge.get('configured') else 'NULL'}"
        f" ({len(hedge.get('receipts') or [])} receipts)  "
        f"sections={'/'.join(k for k in ('marketplace', 'revenue', 'x402', 'x402_exchange_sample'))}"
    )


if __name__ == "__main__":
    main()
