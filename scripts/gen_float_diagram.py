#!/usr/bin/env python
"""Generate the ACR Float architecture diagram (excalidraw).

Float is the agent treasury: the agent's own wallet holds nothing, the vault
prices every purchase against a live compute print, refuses anything above a
fair band, and pulls the exact shortfall out of a yield venue in the same
transaction. This draws the mechanism, not a logo arrangement — a reader should
be able to follow one payment left to right and see where it can be refused.

Deliberately reuses `gen_architecture`'s layout engine (`zone`, `card`, `wire`,
the bound-arrow machinery and the README palette) rather than drawing its own.
The two boards then read as one family, and the lesson that engine already
encodes — every connector BOUND to its two boxes at both ends, so dragging a box
never leaves a dangling arrow — is inherited rather than re-learned.

Deterministic: no RNG, fixed timestamps, so re-running yields byte-identical
output and `--check` can gate it.

    uv run python scripts/gen_float_diagram.py [--check]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import gen_architecture as ga
from gen_architecture import BLUE, GOLD, GRAY, GREEN, ORANGE, PURPLE, RED, TEAL

OUT = Path(__file__).resolve().parent.parent / "acr_float.excalidraw"


def build() -> None:
    # ---- the ask ---------------------------------------------------------
    ga.zone(0, 60, 760, 430, "1 · THE ASK — the agent holds no key that can move money", GRAY)
    ga.card(
        "agent", 40, 120, 310, 150, "scout (the agent)",
        ["wallet: 0.000000 USDC, always", "holds no spending key", "asks; never decides",
         "tested: balance 0 before AND", "after every payment it causes"],
        TEAL,
    )
    ga.card(
        "mcp", 40, 310, 310, 150, "MCP tools",
        ["float_runway  what can I afford", "float_quote   is this price fair",
         "float_pay     pay for compute", "float_receipts what was spent",
         "quote is read-only and free"],
        TEAL,
    )
    ga.card(
        "executor", 420, 215, 300, 150, "executor (backend key)",
        ["the only submitting role", "may SUBMIT and nothing else:", "cannot change policy,",
         "widen a band, or approve", "its own escalation"],
        GRAY,
    )

    # ---- the decision ----------------------------------------------------
    ga.zone(820, 60, 700, 650, "2 · THE DECISION — one transaction, on chain", BLUE)
    ga.card(
        "vault", 860, 120, 620, 330, "FloatVault — the ladder, in order",
        ["paused?                     -> treasury paused",
         "agent known? frozen?        -> agent frozen by policy",
         "seller on the allowlist?    -> seller not allowed",
         "nonce unused?               -> replayed request",
         "print exists? fresh?        -> stale ACR print",
         "printId still current?      -> print changed; re-quote",
         "quote <= fair x (1+band)?   -> quote exceeds ACR fair band",
         "below per-request limit?    -> over per-request threshold",
         "inside the daily cap?       -> daily cap exceeded",
         "",
         "fair = priceWad x units / 1e12   (the ONE conversion)",
         "A refusal is an EVENT, not a revert: Denied carries the",
         "code, the sentence, the quote and the fair counter-price."],
        BLUE, body_size=12,
    )
    ga.card(
        "jit", 860, 490, 290, 180, "just-in-time funding",
        ["buffer short?", "pull the EXACT shortfall", "from the sleeve, then pay",
         "", "proven by LOG ORDER:", "sleeve pull at log N <", "payment at log N+1"],
        GREEN,
    )
    ga.card(
        "receipt", 1190, 490, 290, 180, "Receipt / Denied",
        ["quote, fair, printId, units", "premiumBps, jitFunded,", "guest, humanApproved",
         "", "every outcome is public,", "including every refusal"],
        GOLD,
    )

    # ---- the price -------------------------------------------------------
    ga.zone(0, 540, 760, 400, "3 · THE PRICE OF COMPUTE — measured, not asserted", ORANGE)
    ga.card(
        "keeper", 40, 600, 310, 170, "keeper (every 10 min)",
        ["OpenRouter per-PROVIDER", "prices for 3 models", "0.75/0.25 prompt:completion",
         "trimmed median + spread", "same method as ACR's index"],
        ORANGE,
    )
    ga.card(
        "store", 420, 600, 300, 170, "FloatPrintStore",
        ["priceWad, printId, postedAt", "ciBps = provider spread",
         "printId increments: 'stale'", "and 'rotated' are separate",
         "refusals, enforceable apart"],
        ORANGE,
    )
    ga.card(
        "spread", 40, 800, 680, 110, "why the band is a BAND",
        ["nine providers serve meta-llama/llama-3.3-70b between $0.000155 and $0.000783",
         "per 1k tokens — a five-fold disagreement about one model. The forecaster spends",
         "that spread as its safety margin. A single-provider model is REFUSED, not averaged."],
        ORANGE, body_size=12,
    )

    # ---- the money -------------------------------------------------------
    ga.zone(1580, 60, 620, 650, "4 · THE MONEY — idle float earns until the block it is spent", GREEN)
    ga.card(
        "sleeve", 1620, 120, 540, 170, "Erc4626Sleeve",
        ["holds SHARES, not USDC", "value = convertToAssets(shares)",
         "NOT maxWithdraw: Morpho Vault V2", "returns zero from every max*",
         "by design, which would read as", "an empty sleeve forever"],
        GREEN,
    )
    ga.card(
        "venue", 1620, 330, 540, 150, "Morpho Vault V2 (Arc Testnet)",
        ["0xAabbeF1D…CdB8E88", "real ERC-4626 USDC vault", "zero fees, permissionless:",
         "all four gates are address(0),", "so a CONTRACT may hold shares"],
        GREEN,
    )
    ga.card(
        "seller", 1620, 520, 540, 150, "FloatTestSeller",
        ["labelled in its own name,", "because a demo that pays a", "seller we control should",
         "say so on chain", "sweep() returns the money"],
        GRAY,
    )

    # ---- the human path --------------------------------------------------
    ga.zone(820, 760, 700, 350, "5 · WHAT IT CANNOT AUTHORISE, IT PARKS", PURPLE)
    ga.card(
        "checkpoint", 860, 820, 300, 250, "openCheckpoint",
        ["over the per-request limit", "is NOT a refusal — it is an",
         "escalation, parked on chain", "with a TTL",
         "", "denial, expiry and a failed", "verification are each",
         "recorded on chain: evidence,", "not silence"],
        PURPLE,
    )
    ga.card(
        "approval", 1190, 820, 290, 250, "executeApproved",
        ["one EIP-712 signature,", "bound to that exact", "request hash, usable once",
         "", "the approval WIDENS the", "band; it never removes it",
         "", "a human may authorise", "paying more than usual.", "Nobody may authorise", "paying an unpriced amount."],
        PURPLE, body_size=12,
    )

    # ---- Arc Studio ------------------------------------------------------
    ga.zone(0, 990, 760, 300, "6 · ARC STUDIO — what it did, precisely", RED)
    ga.card(
        "studio", 40, 1050, 680, 220, "Arc Studio's three roles",
        ["COMPILES the policy: the treasurer writes a sentence in English, Studio emits",
         "  JSON, and our own validator REFUSES it if it is wrong — Studio's output is",
         "  checked, not trusted ('I checked it by eye', it said)",
         "AUDITS the vault, including the checkpoint path; findings triaged in commits",
         "DEPLOYS the contracts to Arc Testnet",
         "",
         "It did not write the vault, the tests, the keeper, the agents or the dashboard.",
         "It HOSTS the dashboard byte-for-byte. A narrow claim survives a judge."],
        RED, body_size=12,
    )

    # ---- the dashboard ---------------------------------------------------
    ga.card(
        "dash", 1580, 760, 620, 180, "dashboard — no server behind it",
        ["opens an RPC and reads the vault, the store and the sleeve directly",
         "runway in TOKENS, not dollars: the denominator is the invention",
         "the tape: every payment and every refusal, each linking to the chain",
         "cannot lie about freshness — if the keeper stops, the print ages on screen"],
        GOLD, body_size=12,
    )

    # ---- the flow --------------------------------------------------------
    ga.wire("agent", "mcp", TEAL, side_a="B", side_b="T")
    ga.wire("mcp", "executor", TEAL)
    ga.wire("executor", "vault", GRAY)
    ga.wire("store", "vault", ORANGE, side_a="R", side_b="B")
    ga.wire("keeper", "store", ORANGE)
    ga.wire("vault", "jit", BLUE, side_a="B", side_b="T")
    ga.wire("jit", "sleeve", GREEN, side_a="R", side_b="L")
    ga.wire("sleeve", "venue", GREEN, side_a="B", side_b="T")
    ga.wire("jit", "seller", GREEN, side_a="R", side_b="L", dashed=True)
    ga.wire("vault", "receipt", GOLD, side_a="B", side_b="T")
    ga.wire("receipt", "dash", GOLD, side_a="R", side_b="L")
    ga.wire("vault", "checkpoint", PURPLE, side_a="B", side_b="T", dashed=True)
    ga.wire("checkpoint", "approval", PURPLE)
    ga.wire("approval", "vault", PURPLE, side_a="R", side_b="R", dashed=True)
    ga.wire("studio", "store", RED, side_a="T", side_b="B", dashed=True)


def main() -> None:
    build()
    summary = ga.validate()
    doc = {
        "type": "excalidraw",
        "version": 2,
        "source": "acr-float-architecture-generator",
        "elements": ga._elements,
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
