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
import types
from pathlib import Path

from acr_core import get_settings
from acr_sim import AttackConfig, SimConfig
from acr_tape import SimSource
from fastapi import Response
from index_api.app import build_terminal_payload, revenue, x402_info
from index_api.marketplace import build_catalog, build_sim_receipts
from index_api.onchain import get_reader
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


def embed_bundle_sections(payload: dict) -> dict:
    """Embed the crypto-rich offline sections alongside the terminal payload.

    Every section reuses its live endpoint's builder (``build_catalog``,
    ``revenue``, ``x402_info``); the ledger rows are ``build_sim_receipts`` —
    honestly labeled sim by scheme + tx_ref prefix.
    """
    payload["marketplace"] = {
        "catalog": build_catalog(""),  # resource base "" — host-less offline bundle
        "receipts": build_sim_receipts(),
    }
    # /revenue shape with zeroed counters (a fresh dev gate has sold nothing);
    # the recent ring carries the first 5 sim receipts, oldest first like live.
    rev = revenue(fac=DevFacilitator())
    rev["recent"] = [
        {"payer": r["payer"], "amount_usdc": r["amount_usdc"], "tx_ref": r["tx_ref"]}
        for r in build_sim_receipts(n=5)["receipts"][::-1]
    ]
    payload["revenue"] = rev
    payload["x402"] = x402_info(fac=DevFacilitator())  # the dev gate descriptor
    payload["x402_exchange_sample"] = record_x402_exchange()
    return payload


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
    payload = build_terminal_payload(store, reader)
    if configured:
        check_oracle_commit_guard(_connected_chain_id(reader))
    else:
        assert payload["oracle"] is None
        assert all(p["onchain"] is None for p in payload["prints"].values())
    embed_bundle_sections(payload)
    out = Path("apps/terminal/lib/fallback.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2))
    print(
        f"wrote {out} ({out.stat().st_size:,} bytes)  "
        f"oracle={'set' if configured else 'null'}  "
        f"sections={'/'.join(k for k in ('marketplace', 'revenue', 'x402', 'x402_exchange_sample'))}"
    )


if __name__ == "__main__":
    main()
