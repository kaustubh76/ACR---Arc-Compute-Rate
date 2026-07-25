#!/usr/bin/env python
"""Generate the comprehensive ACR architecture diagram (excalidraw).

The blueprint grew past its original 143-element sketch — this regenerates a
detailed canvas depicting the *implemented* system: the four-pillar estimator in
full, the signer abstraction, EIP-712 on-chain verification, the x402 facilitator
(Dev/Circle), robustness diagnostics, TapeSource (Sim/Arc), on-chain reads, the
Arc native-USDC economics, and the verification surface.

Deterministic (no RNG, fixed timestamps) so re-running yields byte-identical
output. Every connector arrow is *bound* to its two boxes (start/end binding +
boundElements back-refs), the lesson from the earlier wiring pass.

    uv run python scripts/gen_architecture.py [--check]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "acr_architecture.excalidraw"
UPDATED = 1731542400000

# --- palette (the README color code) ---
TEAL, BLUE, GOLD, ORANGE, GREEN, PURPLE, RED, GRAY, INK = (
    "#0c8599", "#1971c2", "#f08c00", "#e8590c", "#2f9e44",
    "#9c36b5", "#e03131", "#495057", "#1e1e1e",
)

_elements: list[dict] = []
_by_id: dict[str, dict] = {}
_boxes: dict[str, tuple[float, float, float, float]] = {}
_ctr = [0]


def _nid(prefix: str) -> str:
    _ctr[0] += 1
    return f"{prefix}-{_ctr[0]:04d}"


def _base(el: dict) -> dict:
    _ctr[0] += 1
    el.setdefault("angle", 0)
    el.setdefault("strokeWidth", 2)
    el.setdefault("strokeStyle", "solid")
    el.setdefault("roughness", 0)
    el.setdefault("opacity", 100)
    el.setdefault("groupIds", [])
    el.setdefault("frameId", None)
    el.setdefault("roundness", None)
    el.setdefault("boundElements", None)
    el.setdefault("link", None)
    el.setdefault("locked", False)
    el.setdefault("isDeleted", False)
    el.setdefault("fillStyle", "solid")
    el.setdefault("backgroundColor", "transparent")
    el["seed"] = 100000 + _ctr[0] * 7
    el["version"] = 1
    el["versionNonce"] = 200000 + _ctr[0] * 13
    el["updated"] = UPDATED
    _elements.append(el)
    _by_id[el["id"]] = el
    return el


def rect(rid, x, y, w, h, stroke, *, dashed=False, bg="transparent", rounded=True, sw=2):
    _base({
        "id": rid, "type": "rectangle", "x": x, "y": y, "width": w, "height": h,
        "strokeColor": stroke, "backgroundColor": bg,
        "strokeStyle": "dashed" if dashed else "solid", "strokeWidth": sw,
        "roundness": {"type": 3} if rounded else None,
    })
    _boxes[rid] = (x, y, w, h)
    return rid


def text(x, y, s, size, color, *, w=None, align="left", bold=False):
    n = s.count("\n") + 1
    height = round(n * size * 1.25, 1)
    width = w if w is not None else max(10, int(max(len(line) for line in s.split("\n")) * size * 0.55))
    _base({
        "id": _nid("t"), "type": "text", "x": x, "y": y, "width": width, "height": height,
        "strokeColor": color, "fontSize": size, "fontFamily": 2 if not bold else 3,
        "textAlign": align, "verticalAlign": "top", "containerId": None,
        "lineHeight": 1.25, "text": s, "originalText": s, "autoResize": False,
    })


def zone(x, y, w, h, title, color):
    rid = rect(_nid("zone"), x, y, w, h, color, dashed=True, rounded=True, sw=2)
    text(x + 18, y + 12, title, 15, color, w=w - 36, bold=True)
    return rid


def card(cid, x, y, w, h, title, lines, color, *, title_size=15, body_size=13):
    rect(cid, x, y, w, h, color, rounded=True, sw=2)
    text(x + 13, y + 10, title, title_size, color, w=w - 24, bold=True)
    if lines:
        text(x + 13, y + 12 + title_size * 1.5, "\n".join(lines), body_size, INK, w=w - 24)
    return cid


def _center(b):
    x, y, w, h = b
    return x + w / 2, y + h / 2


def _edge(b, tx, ty):
    x, y, w, h = b
    cx, cy = x + w / 2, y + h / 2
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    sx = (w / 2) / abs(dx) if dx else 1e9
    sy = (h / 2) / abs(dy) if dy else 1e9
    s = min(sx, sy)
    return cx + dx * s, cy + dy * s


def wire(a, b, color, *, dashed=False, waypoints=(), sw=2):
    ba, bb = _boxes[a], _boxes[b]
    ca, cb = _center(ba), _center(bb)
    aim_a = waypoints[0] if waypoints else cb
    aim_b = waypoints[-1] if waypoints else ca
    sx, sy = _edge(ba, *aim_a)
    ex, ey = _edge(bb, *aim_b)
    pts = [[0.0, 0.0]]
    for wx, wy in waypoints:
        pts.append([round(wx - sx, 2), round(wy - sy, 2)])
    pts.append([round(ex - sx, 2), round(ey - sy, 2)])
    xs = [sx] + [w[0] for w in waypoints] + [ex]
    ys = [sy] + [w[1] for w in waypoints] + [ey]
    aid = _nid("arr")
    _base({
        "id": aid, "type": "arrow", "x": round(sx, 2), "y": round(sy, 2),
        "width": round(max(xs) - min(xs), 2), "height": round(max(ys) - min(ys), 2),
        "strokeColor": color, "strokeStyle": "dashed" if dashed else "solid",
        "strokeWidth": sw, "points": pts, "lastCommittedPoint": None,
        "startArrowhead": None, "endArrowhead": "arrow",
        "startBinding": {"elementId": a, "focus": 0.0, "gap": 6.0},
        "endBinding": {"elementId": b, "focus": 0.0, "gap": 6.0},
    })
    for box_id in (a, b):
        el = _by_id[box_id]
        el["boundElements"] = (el.get("boundElements") or []) + [{"id": aid, "type": "arrow"}]
    return aid


def build() -> None:
    # ---------- masthead + legend ----------
    text(80, 40, "ACR — THE ARC COMPUTE RATE", 32, INK, w=1100, bold=True)
    text(80, 92, "A manipulation-resistant benchmark family for machine commerce · "
                 "one estimand · four pillars · settlement-grade on-chain rate", 15, GRAY, w=1600)

    zone(2860, 40, 620, 250, "LEGEND", GRAY)
    legend = [
        (TEAL, "market exhaust / inputs"), (BLUE, "estimator core (the product)"),
        (GOLD, "ACR prints / judge"), (ORANGE, "on-chain (Foundry)"),
        (GREEN, "instrument (cash-settled)"), (PURPLE, "distribution (x402)"),
        (RED, "adversarial / red team"), (GRAY, "zones / verification"),
    ]
    for i, (c, lbl) in enumerate(legend):
        yy = 84 + i * 24
        rect(_nid("sw"), 2884, yy, 18, 18, c, bg=c, rounded=False, sw=1)
        text(2912, yy - 1, lbl, 13, INK, w=560)

    # ---------- A · MARKET EXHAUST & INGESTION ----------
    zone(60, 300, 620, 790, "A · MARKET EXHAUST & INGESTION", TEAL)
    card("a_x402", 80, 352, 560, 112, "x402 AUTHORIZATIONS",
         ["EIP-3009 signed payloads", "price · size · buyer · seller · ts",
          "highest-frequency observable"], TEAL)
    card("a_gateway", 80, 474, 560, 120, "GATEWAY BATCH SETTLEMENTS",
         ["net positions, settled later", "observed = latent ∘ batch-op + noise",
          "y = H·x + v   (the convolution)"], TEAL)
    card("a_attest", 80, 604, 560, 112, "SELLER ATTESTATIONS",
         ["EIP-712: model class · latency SLO · schema", "→ AttestationRegistry.sol",
          "feeds Pillar-2 features"], ORANGE)
    card("a_adv", 80, 726, 560, 120, "ADVERSARIAL FLOW",
         ["self-deals · reciprocal funding ring", "pure-sybil cluster (all 3 shapes)",
          "a first-class contaminated input"], RED)
    card("a_tape", 80, 856, 560, 120, "TapeSource (ABC)",
         ["SimSource — calibrated simulator", "ArcSource — Arc 5042002 live decode",
          "offline-tolerant · same estimator both"], TEAL)

    # ---------- B · ESTIMATOR CORE ----------
    zone(720, 300, 1480, 900, "B · ESTIMATOR CORE — one estimand: the latent price of machine services", BLUE)
    card("b_indexer", 745, 352, 350, 120, "TAPE INDEXER",
         ["raw event ingestion", "volume-time bars (equal $)",
          "clean ticks — Malachite finality"], BLUE)
    card("b_obs", 1120, 352, 430, 175, "OBSERVATION MODEL · Pillar 1",
         ["observed = latent ∘ batch-H + noise", "state-space; H = box avg, width k",
          "Kalman filter + RTS smoother", "deconvolves batching; var → CI",
          "observation_model.py"], BLUE)
    card("b_clean", 745, 500, 360, 215, "CLEANING STACK",
         ["4 funding-graph defenses:", "· self-deal  (buyer = seller)",
          "· wash-cycle  (reciprocal A↔B)", "· Louvain sybil   I/(I+B)",
          "· 2-sided cluster caps", "~100% injected wash zeroed"], BLUE)
    card("b_robust", 1180, 560, 370, 180, "ROBUST ESTIMATOR",
         ["α-trim volume-weighted median", "breakdown point ½",
          "weighted-bootstrap CI / print", "robust.py"], BLUE)
    card("b_hedonic", 745, 750, 400, 180, "HEDONIC ADJUSTMENT · Pillar 2",
         ["WLS:  log p ~ quality features", "reprice → MID / 250ms reference",
          "→ constant-quality rate", "Case-Shiller for compute", "hedonic.py"], BLUE)
    card("b_robdiag", 1180, 762, 370, 96, "ROBUSTNESS DIAGNOSTICS",
         ["single-cluster flip  c/(0.5(1−2α))", "leave-one-community-out shift (bp)",
          "robustness.py"], BLUE)
    card("b_prints", 1180, 888, 370, 150, "ACR PRINTS (hourly)",
         ["ACR-INF  $/1k tokens", "ACR-GPU  $/GPU-sec", "ACR-DATA  $/MB",
          "+ CI  + attack-cost / bp"], GOLD)
    card("b_bound", 745, 962, 400, 200, "MANIPULATION COST BOUND · Pillar 3",
         ["least surviving wash N* to move 1bp", "threat: cleaning-evading sybil",
          "cost = 2N*·fee_bp + (N*/trade + ids)·fee_flat", "a NUMBER on Arc (deterministic fee)",
          "bound.py + redteam/optimal_attack.py"], RED)

    # ---------- C · ON-CHAIN ----------
    zone(2240, 300, 560, 780, "C · ON-CHAIN (settlement-grade)", ORANGE)
    card("c_signer", 2260, 352, 510, 116, "SIGNER",
         ["LocalKeySigner (raw key · dev)", "CircleWalletSigner — Dev-Controlled Wallet",
          "circle-developer-controlled-wallets SDK"], ORANGE)
    card("c_oracle", 2260, 480, 510, 205, "ACROracle.sol",
         ["EIP-712 verifies the signer", "any relayer submits postPrint",
          "invariants: value∈CI · bound>0", "monotone ts · MAX_TS_SKEW",
          "isStale · pause · 2-step owner"], ORANGE)
    card("c_registry", 2260, 697, 510, 116, "AttestationRegistry.sol",
         ["EIP-712 seller metadata · nonce + deadline",
          "attestWithSig — seller signs, relayer pays",
          "→ one relayer registers many sellers"], ORANGE)
    card("c_foundry", 2260, 825, 510, 92, "FOUNDRY",
         ["32 tests · invariant suite (fail_on_revert)"], ORANGE)
    card("c_deploy", 2260, 929, 510, 132, "CIRCLE DEPLOY",
         ["Smart Contract Platform + Gas Station", "deploy / import-by-address → setSigner",
          "deploy_circle.py (--dry-run) · verify_deploy.py"], ORANGE)

    # ---------- D · INSTRUMENT ----------
    zone(2240, 1110, 560, 350, "D · INSTRUMENT (Pillar 4)", GREEN)
    card("d_future", 2260, 1162, 510, 128, "ACR-WEEKLY FUTURE",
         ["cash-settled vs oracle print", "no delivery · no bonds", "future.py"], GREEN)
    card("d_mm", 2260, 1302, 510, 128, "MARKET MAKER",
         ["Avellaneda–Stoikov quotes", "first term structure in machine commerce",
          "market_maker.py"], GREEN)

    # ---------- E · DISTRIBUTION ----------
    zone(720, 1250, 1480, 360, "E · DISTRIBUTION (self-referential · x402-monetized)", PURPLE)
    card("e_api", 745, 1302, 430, 190, "INDEX API (FastAPI)",
         ["x402-gated: /prints /curve /vol", "/marketplace /webhooks /demo/buyer",
          "lifespan refresh + poster loop", "/onchain reader (90s TTL cache)"], PURPLE)
    card("e_facil", 1195, 1302, 430, 190, "x402 FACILITATOR",
         ["Dev (mock) | Circle (Nanopayments)", "gateway-api-testnet.circle.com /v1/x402",
          "/verify + /settle · scheme exact · fail-closed", "GatewayWalletBatched · GatewayWallet 0x0077…"], PURPLE)
    card("e_term", 1660, 1302, 510, 190, "ACR TERMINAL (Next.js · 'Arc Dawn')",
         ["editorial 'The Fixing' · /attack /curve /exchange", "ChainFactsStrip · OracleProvenance (tx·block)",
          "FinalityBadge · SettlementTape · WebhookActivity", "SWR live polling · apps/terminal"], PURPLE)

    # ---------- K · AGENTIC ECONOMY (demand side) ----------
    zone(720, 1630, 1480, 250, "K · AGENTIC ECONOMY (demand side · the loop closes)", PURPLE)
    card("k_market", 745, 1682, 430, 168, "AGENT MARKETPLACE",
         ["/marketplace/catalog — listings", "/marketplace/receipts — paid-query ledger",
          "the index listed as a payable service", "marketplace.py"], PURPLE)
    card("k_agent", 1195, 1682, 430, 168, "AUTONOMOUS x402 BUYER",
         ["apps/agent — TS · viem · GatewayClient", "DevPayer | GatewayPayer · USDC spend cap",
          "discovers catalog → pays per query → receipts", "interop.ts (12-check conformance)"], PURPLE)
    card("k_webhooks", 1660, 1682, 510, 168, "CIRCLE WEBHOOKS",
         ["/webhooks/circle — settlement events", "→ SettlementTape on the Terminal",
          "in-app floor buyer: /demo/buyer/*", "webhooks.py · buyer_demo.py"], PURPLE)

    # ---------- G · RED TEAM / LIVE DEMO ----------
    zone(60, 1150, 620, 300, "G · RED TEAM / LIVE DEMO", RED)
    card("g_demo", 80, 1202, 560, 150, "ATTACK THE INDEX  (5-step)",
         ["1  baseline: ACR printing hourly", "2  unleash wash-flow bot",
          "3  naive VWAP swings wildly", "4  ACR barely moves",
          "5  attack-cost counter burns USDC"], RED)
    card("g_opt", 80, 1362, 560, 78, "optimal_attack.py",
         ["runs the priced attack through real clean()", "→ the bound is attainable, not loose"], RED)

    # ---------- H · VERIFICATION ----------
    zone(2240, 1500, 560, 300, "H · VERIFICATION", GRAY)
    card("h_tests", 2260, 1552, 510, 180, "TESTS · 165 py + 32 forge",
         ["+ agent TS + interop conformance", "eval gate: VWAP 107–123% · ACR <3% → 50–560×",
          "glossary gate · ruff · GitHub CI", "hermetic conftest (Circle mocked)"], GRAY)

    # ---------- Judge Fit + Demo Metrics (far right) ----------
    card("j_judge", 2860, 320, 620, 240, "JUDGE FIT (surgical)",
         ["ICE administers LIBOR via IBA — on Arc roster", "Apollo · BNY · Mastercard: benchmark-native",
          "SOFR was methodology-first, liquidity-second", "the rate's administrator ≠ the rail's operator",
          "(the LIBOR neutrality lesson = the moat)"], GOLD)
    card("j_metrics", 2860, 590, 620, 470, "DEMO-DAY METRICS",
         ["methodology paper published (OSS)", "N hourly prints live on-chain",
          "attack-cost-per-bp on EVERY print", "X wash attacks absorbed (red-team)",
          "naive-VWAP err  vs  ACR err  (chart)", "live future quotes + Y settled trades",
          "5+ sellers attested on-chain", "100% Foundry invariants passing",
          "100 python + 32 forge tests green"], INK)

    # ---------- PLAIN ENGLISH glossary panel ----------
    zone(2860, 1090, 620, 800, "PLAIN ENGLISH  ·  read the jargon", GOLD)
    glossary = [
        "latent price — the real price you can't see; ACR estimates it",
        "benchmark / rate — the official number contracts settle on (SOFR)",
        "VWAP — a plain volume-weighted average; fake volume fools it",
        "hedonic — strip quality gaps so you compare like-for-like",
        "constant-quality — price with quality removed; moves w/ the market",
        "observation model — 'what we see = true price, blurred + noisy'",
        "convolution / batching — settlements smear trades together in time",
        "deconvolution — un-smear it to recover the true price",
        "Kalman filter — recover a clean signal from noisy, delayed data",
        "RTS smoother — a backward pass that sharpens earlier estimates",
        "batch operator H — the known 'recipe' of the blur, so we can invert",
        "volume-time bars — sample per equal $ traded, not per clock tick",
        "WLS — regression that weights bigger trades more heavily",
        "α-trim median (VWM) — drop the extreme few %, keep the middle",
        "breakdown ½ — survives up to 50% bad data before it breaks",
        "bootstrap CI — resample to get an honest 'give-or-take' range",
        "LOCO — drop each cluster in turn; how far does the rate move?",
        "sybil — many fake identities run by one attacker",
        "wash trade / self-deal — fake trades to pump volume or price",
        "reciprocal ring — money loops A→B→A; volume looks real, net ≈ 0",
        "Louvain — finds tight clusters in a who-paid-whom graph",
        "manipulation bound — least USDC (N*) to move the rate 1 bp",
        "basis point (bp) — one hundredth of a percent (0.01%)",
        "oracle — on-chain contract that publishes the rate to read",
        "postPrint / relayer — publish the rate; anyone may submit it",
        "signer (Local | Circle) — who holds the key that signs the rate",
        "EIP-712 verify — contract checks WHO signed, not who sent it",
        "MAX_TS_SKEW / isStale — reject far-future or too-old prints",
        "nonce + deadline — one-time counter + expiry ⇒ replay-proof",
        "2-step ownership — new admin must accept ⇒ no wrong-address handoff",
        "Malachite finality — Arc confirms in <1s and never reverses (no reorgs)",
        "EIP-3009 — pay by signing a message (no separate approval tx)",
        "x402 / Nanopayments — pay-per-call in sub-cent USDC (HTTP 402)",
        "facilitator /verify /settle — check the payment, then move the USDC",
        "fail-closed — if payment can't verify, deny (the safe default)",
        "Arc / USDC-gas — Circle's chain; fees are paid in USDC itself",
        "testnet — a practice chain with fake-value tokens",
        "TapeSource — one data-in interface: SimSource | ArcSource",
        "/onchain reader — API serves the rate read straight from chain",
        "SSR — web page built on the server; loads fast",
        "settlement-grade — trustworthy enough for contracts to settle on",
        "cash-settled future — bet on the rate; pays the diff, no delivery",
        "Avellaneda–Stoikov — a recipe for a market maker's buy/sell quotes",
        "buyer agent — a machine that auto-discovers + pays for the index",
        "Agent Marketplace — catalog of payable services + receipts ledger",
        "GatewayWalletBatched — Circle contract the x402 payment signs against",
        "meta-attestation (attestWithSig) — seller signs, a relayer pays gas",
        "Circle wallet / SCP — custodial signer + on-chain deploy platform",
        "webhook — Circle pings the API when a settlement lands",
        "SettlementTape — the Terminal's live feed of on-chain settlements",
        "SWR — the Terminal auto-refreshes its data every few seconds",
    ]
    text(2884, 1132, "\n".join(glossary), 11, INK, w=588)
    text(2884, 1862, "full glossary (every term) → docs/GLOSSARY.md", 10.5, GRAY, w=560)

    # ---------- F · WHY ARC ----------
    zone(60, 1900, 3420, 250,
         "F · WHY ARC — load-bearing for the MATH, not the deployment    ·    chain 5042002 · USDC = native gas token", TEAL)
    why = [
        ("ARC L1 (Malachite)", ["deterministic sub-second finality · no reorgs",
                                 "chain 5042002 · rpc.testnet.arc.network"]),
        ("CIRCLE GATEWAY", ["single canonical rail", "= complete observation, no selection bias"]),
        ("NANOPAYMENTS (x402)", ["sub-cent index monetization", "agents are the paying customers"]),
        ("USDC NUMERAIRE", ["native system contract 0x3600… = gas token",
                            "no deflator · no Paymaster (gasless intrinsic)"]),
        ("DETERMINISTIC USDC FEES", ["wash volume has a known, fixed cost", "→ the manipulation bound is a NUMBER"]),
        ("AGENT MARKETPLACE", ["ACR listed as a payable service", "agents discover + pay natively (Zone K)"]),
    ]
    for i, (t, lines) in enumerate(why):
        card(f"f{i}", 80 + i * 566, 1975, 520, 150, t, lines, TEAL)

    # ---------- 7-week roadmap ----------
    zone(60, 2200, 3420, 340,
         "7-WEEK EXECUTION — cut lines: hedonic → class-buckets · future → paper-traded · NEVER cut W4 adoption or the paper", GRAY)
    weeks = [
        ("W1 — TAPE", ["indexer live on Arc testnet", "empirical batching study", "OSS: microstructure paper"]),
        ("W2 — ESTIMATOR v1", ["state-space filter", "trimmed VWM + first prints", "METHODOLOGY PAPER out"]),
        ("W3 — ON-CHAIN", ["AttestationRegistry +", "ACROracle contracts", "full invariant suite"]),
        ("W4 — ADOPTION ★", ["sellers attest metadata", "x402 index API live", "oracle consumed by partners"]),
        ("W5 — RED TEAM", ["manipulation bound derived", "attack own index (wash bots)", "publish attack-cost/bp"]),
        ("W6 — INSTRUMENT", ["weekly cash-settled future", "A-S MM quoting live", "Mission Control trading"]),
        ("W7 — SHIP", ["freeze Monday", "paper polish + rehearse", "attack demo twice"]),
    ]
    for i, (t, lines) in enumerate(weeks):
        card(f"w{i}", 80 + i * 486, 2270, 450, 240, t, lines, GRAY if i != 3 else ORANGE)

    # ---------- WIRING (all bound) ----------
    wire("a_x402", "b_indexer", TEAL)              # ①
    wire("a_gateway", "b_indexer", TEAL)           # ②
    wire("a_adv", "b_indexer", RED)                # contaminated flow
    wire("a_tape", "b_indexer", TEAL, dashed=True)  # TapeSource feeds ingestion
    wire("b_indexer", "b_obs", BLUE)               # ③ deconvolve
    wire("b_indexer", "b_clean", BLUE)             # ④ clean
    wire("b_obs", "b_robust", BLUE)                # ⑤
    wire("b_clean", "b_robust", BLUE)              # ⑤
    wire("b_robust", "b_hedonic", BLUE)            # ⑥
    wire("a_attest", "b_hedonic", ORANGE, dashed=True)  # quality features (via registry)
    wire("b_robust", "b_robdiag", BLUE, dashed=True)
    wire("b_hedonic", "b_prints", BLUE)
    wire("b_prints", "b_bound", RED)               # ⑦ per-print bound
    wire("a_attest", "c_registry", ORANGE, dashed=True,
         waypoints=[(1930, 660), (1930, 755)])     # attest → registry (corridor)
    wire("c_signer", "c_oracle", ORANGE)           # signer signs the print
    wire("b_prints", "c_oracle", ORANGE)           # ⑧ signed print posted
    wire("c_oracle", "d_future", GREEN)            # ⑨ cash-settlement reference
    wire("d_mm", "d_future", GREEN)                # quotes
    wire("c_oracle", "e_api", ORANGE, dashed=True,
         waypoints=[(2210, 900), (1180, 1290)])    # /onchain read
    wire("b_bound", "e_api", PURPLE)               # ⑩ prints sold via x402
    wire("e_facil", "e_api", PURPLE)               # x402 verify/settle
    wire("e_api", "e_term", PURPLE)                # serves the terminal
    wire("e_api", "f2", PURPLE, dashed=True)        # $ loop → Nanopayments
    wire("f0", "b_indexer", TEAL, dashed=True,
         waypoints=[(700, 1960), (700, 470)])      # Arc L1 → canonical tape
    wire("a_adv", "g_demo", RED, dashed=True)       # same bots power the demo
    # Zone K — the demand side / the loop closes
    wire("k_agent", "e_facil", PURPLE)              # buyer pays per query via x402 (the $ loop, made real)
    wire("k_agent", "k_market", PURPLE, dashed=True)   # discovers the index via catalog
    wire("e_api", "k_market", PURPLE, dashed=True)     # API lists the index in the marketplace
    wire("e_facil", "k_webhooks", PURPLE, dashed=True)  # settlement → Circle webhook


def validate() -> dict:
    arrows = [e for e in _elements if e["type"] == "arrow"]
    rects = [e for e in _elements if e["type"] == "rectangle"]
    texts = [e for e in _elements if e["type"] == "text"]
    ids = {e["id"] for e in _elements}
    for a in arrows:
        for side in ("startBinding", "endBinding"):
            eid = a[side]["elementId"]
            assert eid in ids, f"{a['id']} {side} → missing {eid}"
            refs = _by_id[eid].get("boundElements") or []
            assert any(r["id"] == a["id"] for r in refs), f"{a['id']} not back-referenced by {eid}"
    return {"rectangles": len(rects), "text": len(texts), "arrows": len(arrows), "total": len(_elements)}


def main() -> None:
    build()
    summary = validate()
    doc = {
        "type": "excalidraw", "version": 2, "source": "acr-architecture-generator",
        "elements": _elements,
        "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
        "files": {},
    }
    if "--check" in sys.argv:
        print("dry-run:", summary)
        return
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    print(f"wrote {OUT.name}: {summary}")
    print(f"  arrows: {summary['arrows']} (all bound)")


if __name__ == "__main__":
    main()
