#!/usr/bin/env python3
"""Generate the World ID continuity board (excalidraw).

    uv run python scripts/gen_world_diagram.py [--check]

WHAT THIS DRAWS, AND WHY IT IS NOT ONE OF THE OTHER THREE BOARDS. The entry is
on World's Continuity track, whose claim is that this is a real integration into
a product that already existed rather than a demo built around a badge. The
architecture canvas draws the whole repo, `acr_float` draws the money mechanism,
and the pivot board demotes the index. None of them draws the integration, so a
reader has to take the continuity claim on trust.

THE THESIS, IN ONE LINE: **the existing product supplies the price, World ID
supplies the person, and the vault is where they meet.** ACR has been printing a
compute rate on Arc since 2026-09-27. The vault refuses any spend above a fair
band derived from that live print. World ID Agent Pass is the only thing that
may authorise exceeding it. Remove ACR and there is no "fair" to exceed; remove
World and there is nobody who may. That seam is the integration, and it is the
one wire this board exists to make visible.

HONESTY IS A DRAWING RULE, inherited verbatim from `gen_pivot_diagram.py`:
solid is working today, dashed is built but not yet run live, red is a gap
stated in words. The temptation on this board is the release box -- a reader
most wants to assume money has moved under a real token, and that is exactly
the thing that has not happened, so it is dashed and says so.

Deliberately reuses `gen_architecture`'s layout engine rather than re-deriving
the excalidraw wire format, as both sibling boards do: same palette, same
`text`/`zone`/`card`/`wire` vocabulary, same bound-arrow validation so no arrow
can be left dangling. Deterministic: fixed seeds and timestamps, so re-running
is byte-identical and `--check` can gate it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gen_architecture as ga  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "acr_world.excalidraw"

TEAL, BLUE, GOLD, GREEN, PURPLE, RED, GRAY, INK = (
    ga.TEAL, ga.BLUE, ga.GOLD, ga.GREEN, ga.PURPLE, ga.RED, ga.GRAY, ga.INK
)

#: The nine rungs, in the order `IdTokenValidator.check()` fires them. Read out
#: of `worldauth.py` rather than remembered, because a ladder drawn in the wrong
#: order is a drawing that teaches the wrong thing: the signature is checked
#: before the issuer, and the enrolled treasurer last, because it is the only
#: rung that needs to know who we previously agreed to trust.
RUNGS = [
    "1  malformed_token",
    "2  bad_signature          ← alg pinned to RS256",
    "3  wrong_issuer",
    "4  wrong_audience",
    "5  expired",
    "6  assurance_not_accepted ← orb / orb-face",
    "7  amr_not_accepted       ← face required, mfa forbidden",
    "8  auth_time_outside_window",
    "9  not_the_enrolled_treasurer",
]


def dcard(cid, x, y, w, h, title, lines, color, *, title_size=15, body_size=13):
    """`ga.card`, but dashed. The engine's `card()` is solid-only, and the
    stroke style is load-bearing here -- it is the difference between "this
    runs" and "this is built and has not run"."""
    ga.rect(cid, x, y, w, h, color, dashed=True, rounded=True, sw=2)
    ga.text(x + 13, y + 10, title, title_size, color, w=w - 24, bold=True)
    if lines:
        ga.text(x + 13, y + 12 + title_size * 1.5, "\n".join(lines), body_size, INK, w=w - 24)
    return cid


def build() -> None:
    #: The engine keeps its scene in module-level lists, so clear them or this
    #: board inherits the entire repo canvas. Its `build()` only runs under
    #: `__main__`, so importing it is safe.
    ga._elements.clear()
    ga._by_id.clear()
    ga._boxes.clear()

    ga.text(80, 40, "ACR Float · World ID Agent Pass, integrated into a product that already ran",
            26, INK, bold=True)
    ga.text(80, 78,
            "The existing product supplies the PRICE.  World ID supplies the PERSON.  "
            "The vault is where they meet.",
            16, GRAY)

    # ---- what already ran -------------------------------------------------
    ga.zone(60, 130, 2120, 190,
            "1 · WHAT ALREADY RAN — ACR on Arc, live since 2026-09-27, before this hackathon", TEAL)
    ga.card("a_index", 90, 176, 330, 110, "the compute-rate index",
            ["ACR-INF · GPU · DATA", "a price for renting compute"], TEAL)
    ga.card("a_oracle", 450, 176, 330, 110, "ACROracle / V2",
            ["Arc chain 5042", "+ AttestationRegistry"], TEAL)
    ga.card("a_print", 810, 176, 330, 110, "the hourly print",
            ["posted on chain by the press", "every print carries its age"], TEAL)
    ga.card("a_press", 1170, 176, 330, 110, "the press · acr-api",
            ["x402 seller, Circle Gateway", "settles real USDC"], TEAL)
    ga.card("a_term", 1530, 176, 330, 110, "the terminal",
            ["arc-compute-rate.vercel.app", "public, reads the chain"], TEAL)
    ga.card("a_pre", 1890, 176, 260, 110, "none of it new",
            ["7 contracts, first prints", "2026-09-27"], GRAY)
    for a, b in (("a_index", "a_oracle"), ("a_oracle", "a_print"),
                 ("a_print", "a_press"), ("a_press", "a_term")):
        ga.wire(a, b, TEAL)

    # ---- the treasury, priced against that print --------------------------
    ga.zone(60, 360, 1400, 240,
            "2 · THE TREASURY — every spend priced against that same print", GOLD)
    ga.card("b_agent", 90, 406, 300, 110, "the agent",
            ["its own wallet holds $0", "it may only ASK"], GOLD)
    ga.card("b_class", 450, 406, 330, 110, "the vault classifies",
            ["fair band from the LIVE print", "↑ this is the integration"], GOLD)
    ga.card("b_pay", 810, 406, 300, 110, "in band → it pays",
            ["no human, no delay", "Receipt on chain"], GREEN)
    ga.card("b_park", 1150, 406, 280, 110, "out of band → PARKED",
            ["code 10 · quote exceeds", "ACR fair band"], PURPLE)
    ga.wire("b_agent", "b_class", GOLD)
    ga.wire("b_class", "b_pay", GREEN)
    ga.wire("b_class", "b_park", PURPLE)

    #: THE SEAM. The one wire the board exists for: the price that was already
    #: being published is the thing the treasury refuses to exceed.
    ga.wire("a_print", "b_class", TEAL, side_a="B", side_b="T")
    ga.text(800, 336, "the live print IS the policy input  ─ remove it and there is no "
            "‘fair’ to exceed", 14, TEAL)

    # ---- World ID ---------------------------------------------------------
    ga.zone(60, 640, 1400, 420,
            "3 · WORLD ID AGENT PASS — the only thing that may authorise exceeding it  ·  LIVE", PURPLE)
    ga.card("c_disc", 90, 686, 320, 116, "discovery",
            ["issuer checked against config", "1.6 s median of 5"], PURPLE)
    ga.card("c_claim", 440, 686, 320, 116, "essential acr claim",
            ["a values ARRAY, not value", "a bare acr_values asks nothing"], PURPLE)
    ga.card("c_dev", 790, 686, 320, 116, "device authorization",
            ["a user code on a phone", "no redirect, no browser"], PURPLE)
    ga.card("c_poll", 1140, 686, 290, 116, "the poll table",
            ["slow_down widens EVERY", "later interval · 503 is", "never an approval"], PURPLE)
    ga.card("c_tok", 90, 836, 320, 116, "an RS256 ID token",
            ["approved by a person,", "twice: 84.0 s and 49.4 s"], PURPLE)
    ga.card("c_appr", 440, 836, 320, 116, "EIP-712 approval",
            ["signed by the approver key", "single-use, bound to one", "checkpoint"], PURPLE)
    ga.card("c_amr", 790, 836, 640, 116, "what only the live token revealed",
            ["acr said orb while amr said [‘pop’,‘user’,‘mfa’] — a passkey unlock.",
             "acr answers HOW STRONG; amr answers HOW FRESH, and only amr can tell you.",
             "That token may move money and may NOT change the rules."], GOLD,
            body_size=12)
    for a, b in (("c_disc", "c_claim"), ("c_claim", "c_dev"), ("c_dev", "c_poll")):
        ga.wire(a, b, PURPLE)
    ga.wire("c_poll", "c_tok", PURPLE, side_a="B", side_b="T", lane=820)
    ga.wire("c_tok", "c_appr", PURPLE)
    ga.wire("b_park", "c_dev", PURPLE, side_a="B", side_b="T")

    # ---- the ladder -------------------------------------------------------
    ga.card("d_ladder", 1500, 640, 680, 420,
            "4 · VALIDATED IN THE BACKEND — nine rungs, first failure reported",
            RUNGS + ["",
                     "The browser never sees the token. The device code never reaches a log,",
                     "a response or a public view. The client secret authenticates with Basic",
                     "and never enters a body. alg:none and HS256-signed-with-the-RSA-public-",
                     "key are both refused, so an unvalidated response is never authorization."],
            BLUE, body_size=13)
    ga.wire("c_appr", "d_ladder", BLUE, side_a="R", side_b="L")

    # ---- the outcome ------------------------------------------------------
    ga.zone(60, 1100, 2120, 250, "5 · THE PROTECTED ACTION, AND EVERY WAY IT DOES NOT HAPPEN", GREEN)
    dcard("e_rel", 90, 1146, 420, 180, "released  ·  BUILT, NOT YET RUN LIVE",
          ["executeApproved moves USDC to the seller,",
           "then the checkpoint is CONSUMED and cannot",
           "be replayed.",
           "",
           "Proven with a synthetic token and against a",
           "local fake issuer. NEVER under a real token:",
           "three live windows closed unapproved."], GREEN, body_size=12)
    ga.card("e_ref", 540, 1146, 460, 180, "refused  ·  LIVE, and six ways on chain",
            ["A real device authorization, no approval, and the",
             "chain as the witness: balance unchanged and the",
             "checkpoint still OPEN — recoverable, not spent.",
             "",
             "Denied · expired · replayed · wrong agent ·",
             "wrong signer · fabricated id  — each asserted",
             "against the chain, not against a log."], GREEN, body_size=12)
    dcard("e_roles", 1030, 1146, 420, 180, "the public vault  ·  AWAITING THREE TXS",
          ["0xb030e7e5… on Arc chain 5042002.",
           "",
           "isExecutor(press) is false; humanApprover and",
           "guestRegistrar are still the deployer. The gate",
           "refuses BY NAME in advance, so this cannot be",
           "discovered mid-demo. Three owner calls fix it."], GOLD, body_size=12)
    ga.card("e_bind", 1480, 1146, 340, 180, "treasurerBinding = 0",
            ["keccak(‘acr.treasurer::’ ‖ iss ‖ 0x1f ‖ sub),",
             "ONE-SHOT from zero.",
             "",
             "Still zero on the public vault, so the chain",
             "pins no particular person yet and the",
             "server-side ladder is what enforces identity.",
             "The value is computed and verified."], RED, body_size=12)
    ga.card("e_legend", 1850, 1146, 300, 180, "how to read this board",
            ["SOLID   runs today",
             "DASHED  built, not yet run live",
             "RED     a gap, stated in words",
             "",
             "A diagram that flatters the",
             "system is the one a reviewer",
             "catches first."], GRAY, body_size=12)
    ga.wire("d_ladder", "e_rel", GREEN, side_a="B", side_b="T")
    ga.wire("d_ladder", "e_ref", GREEN, side_a="B", side_b="T", dashed=True)


def main() -> None:
    build()
    summary = ga.validate()
    doc = {
        "type": "excalidraw",
        "version": 2,
        "source": "acr-world-generator",
        "elements": ga._elements,
        "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
        "files": {},
    }
    if "--check" in sys.argv:
        print("dry-run:", summary)
        return
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    rel = OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT
    print(f"wrote {rel}: {summary}")


if __name__ == "__main__":
    main()
