#!/usr/bin/env python
"""Check that the numbers in the judge-facing docs are still true.

This project's whole argument is that its claims are true, and its front door is
a table of them. But numbers written into prose rot silently: every figure this
script found stale was correct the day it was typed, and nothing in the repo
noticed when the suites grew past it. `verify_live.py` proves the deployed
product; this proves the documentation.

The claims are **parsed out of the docs** and re-measured, rather than compared
against a second hardcoded list — a checker that carries its own copy of the
answer is a mirror, and drifts in step with whatever it was meant to catch.

Measuring costs real time (it collects the test suites), so the expensive checks
are skippable for a quick pass:

    uv run python scripts/verify_claims.py          # == make verify-claims
    CLAIMS_FAST=1 …                                 # skip suite collection

Exit codes: 0 = every claim still holds; 1 = a document is lying.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from functools import cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
#: The Readme is the first thing a judge opens and the last thing anyone
#: re-reads. Its Demo-Day Metrics block states the receipts count, so it is
#: parsed here for the same reason the deck is.
README = ROOT / "README.md"
SUBMISSION = ROOT / "docs" / "SUBMISSION.md"
STATUS = ROOT / "docs" / "IMPLEMENTATION_STATUS.md"
#: The gap-analysis doc drifted furthest of all — 230/50/60 against a suite of
#: 303/60/91, "~49 commits" against 170 — because it was the one judge-facing
#: doc this file never count-checked. Phrase checks alone let every number rot.
MVP = ROOT / "docs" / "MVP_STATUS.md"
#: The deck is the artefact a judge actually reads, and it was the most
#: drifted: it claimed 230 py / 332 glossary / 50 terminal against a suite of
#: 273 / 386 / 55, and narrated a series that had already been rolled twice.
#: It went unchecked for the dullest reason — nothing parsed it.
DECK = ROOT / "docs" / "presentation.md"
#: The eight-slide deck that replaced the long one as the thing actually
#: presented. It states the same four suite counts on its proof slide, in HTML
#: rather than markdown, and it is generated into two more files — so an
#: undercount here would be wrong in the deck, in docs/pitch/index.html and in
#: the PDF a judge downloads. Guarded from the source; the generated copies
#: cannot disagree with it because build_pitch.py never edits the numbers.
PITCH = ROOT / "docs" / "pitch" / "deck.html"
#: The submission brief answers the form's nine fields. Its source is
#: MARKDOWN (docs/SUBMISSION-BRIEF.md — the file a human pastes from), and it
#: is rendered to docs/submission-brief.pdf, where a stale count would outlive
#: every redeploy. It states the suite counts in the deck's markdown phrasing
#: (`**367 py**`), so the deck patterns re-apply verbatim.
BRIEF = ROOT / "docs" / "SUBMISSION-BRIEF.md"
#: The continuity submission's own diff statistics. Unregistered until now, which
#: is exactly why they drifted: it is the one document a judge opens to check
#: honesty, and nothing was re-deriving the numbers it invites you to re-derive.
CONTINUITY = ROOT / "CONTINUITY.md"
FAST = os.environ.get("CLAIMS_FAST", "") not in ("", "0", "false")

_failures: list[str] = []


def check(ok: bool, label: str) -> bool:
    print(f"  {'✓' if ok else '✗'} {label}")
    if not ok:
        _failures.append(label)
    return ok


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 900) -> str:
    """Capture a command's output; '' when it cannot run (never raises, so one
    missing toolchain reports itself instead of hiding every other claim)."""
    try:
        p = subprocess.run(
            cmd, cwd=cwd or ROOT, capture_output=True, text=True, timeout=timeout
        )
        return (p.stdout or "") + (p.stderr or "")
    except Exception as exc:  # noqa: BLE001 — a verdict beats a traceback
        return f"__ERROR__ {exc}"


def git_lines(args: list[str]) -> list[str] | None:
    """stdout lines for a git command, or None when git REFUSED.

    `run()` deliberately folds stderr into stdout so a missing toolchain reports
    itself. For measurements that is the wrong trade: in CI this turned
    `git log --oneline v1.0-submission..0aff288` — which fails outright in the
    shallow clone `actions/checkout` makes by default — into a three-line error
    message that got counted as THREE COMMITS, and the continuity claims were
    reported STALE against numbers that were never measured.

    A failure must not be able to look like a small answer. None means "could not
    measure", which is a different fact from "measured and it disagrees", and the
    caller is obliged to say which.
    """
    try:
        p = subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=120
        )
    except Exception:  # noqa: BLE001 — a verdict beats a traceback
        return None
    if p.returncode != 0:
        return None
    return p.stdout.splitlines()


def claim(text: str, pattern: str) -> int | None:
    """The first integer a documented claim asserts, or None if the doc no
    longer phrases it that way — which is itself worth reporting, because a
    check silently matching nothing is a check that always passes."""
    m = re.search(pattern, text)
    return int(m.group(1).replace(",", "")) if m else None


#: The architecture canvas states the suite sizes on two of its cards, and
#: docs/ARCHITECTURE-DIAGRAM.md advertises that canvas as "implementation-accurate" — so those are
#: claims, not decoration. They rotted to 289 py / 81 terminal against a suite of
#: 367 / 95 for exactly the reason the deck rotted before it was parsed here:
#: nothing read them. The sentence lives in three committed files (the generator,
#: the canvas it writes, and the SVG the deck renders from it); the canvas and
#: the SVG are both checked, because "edited the generator, forgot `make
#: diagram`" has already happened twice in this history.
DIAGRAM = ROOT / "acr_architecture.excalidraw"
DIAGRAM_SVG = ROOT / "docs" / "assets" / "acr_architecture.preview.svg"
#: Matches both spellings the canvas uses — "TESTS · N py + N forge + …" on the
#: verification card and "N py · N forge · … — green" on the metrics card. Only
#: the separator differs.
SUITES_RE = re.compile(
    r"(\d+)\s*py\s*[·+]\s*(\d+)\s*forge\s*[·+]\s*(\d+)\s*terminal\s*[·+]\s*(\d+)\s*agent"
)


def diagram_suite_claims(path: Path) -> list[tuple[int, ...]]:
    """Every (py, forge, terminal, agent) tuple an artefact states.

    A list rather than a first match on purpose: two cards say this, and a card
    edited alone must report as a disagreement instead of hiding behind its twin.
    """
    if not path.exists():
        return []
    text = path.read_text()
    if path.suffix == ".excalidraw":
        doc = json.loads(text)
        text = "\n".join(
            e.get("text", "") for e in doc["elements"] if e.get("type") == "text"
        )
    return [tuple(int(g) for g in m) for m in SUITES_RE.findall(text)]


# --- the measurements -------------------------------------------------------


@cache
def measured_pytest() -> int | None:
    """Collected, not executed — cheap, and it counts the anvil-gated tests that
    SKIP on a machine without a node. Deliberately not `-q`: that suppresses the
    very summary line this needs."""
    out = run(["uv", "run", "pytest", "packages", "services", "tests",
               "-p", "no:cacheprovider", "--collect-only"])
    m = re.search(r"(\d+)\s+tests? collected", out)
    return int(m.group(1)) if m else None


@cache
def measured_forge() -> int | None:
    """Plain `forge test` — `--summary` prints a table and moves the one-line
    total out of reach."""
    out = run(["forge", "test"], cwd=ROOT / "contracts")
    m = re.search(r"(\d+) tests? passed", out)
    return int(m.group(1)) if m else None


@cache
def measured_terminal() -> int | None:
    out = run(["npm", "test"], cwd=ROOT / "apps" / "terminal")
    # `node --test` reports TAP ("# pass 12") on node 20, which is what CI pins,
    # and the spec reporter ("i pass 12") on newer node. Accept both: matching
    # only CI's format meant a developer on a current runtime saw every terminal
    # claim reported as unmeasurable, which reads exactly like documentation
    # that has drifted — and the fix for that looks like editing the docs.
    m = re.search(r"^# pass (\d+)$", out, re.M) or re.search(r"^\D? ?pass (\d+)$", out, re.M)
    return int(m.group(1)) if m else None


@cache
def measured_glossary() -> int | None:
    out = run(["uv", "run", "python", "scripts/check_glossary_coverage.py"])
    m = re.search(r"all (\d+) uncommon diagram terms", out)
    return int(m.group(1)) if m else None


def measured_matchstick() -> int | None:
    """The subgraph mappings' own suite.

    A fifth measurement rather than a fifth column across seven docs: the file
    already argues that a claim should be parsed out of the docs rather than
    carried twice, and the same logic says one new checker beats one new number
    in every deck. Costly — `graph test` compiles WASM — so CLAIMS_FAST skips it.
    """
    out = run(["npx", "graph", "test"], cwd=ROOT / "graph")
    m = re.search(r"All (\d+) tests passed", out)
    return int(m.group(1)) if m else None


def measured_ci_jobs() -> int:
    """Jobs in ci.yml — top-level keys under `jobs:`, counted from the file so a
    new job shows up here without anyone remembering to say so."""
    text = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    body = text.split("\njobs:", 1)[-1]
    return len(re.findall(r"^  ([a-z][\w-]*):", body, re.M))


def measured_workflows() -> int:
    return len(list((ROOT / ".github" / "workflows").glob("*.yml")))


# --- the checks -------------------------------------------------------------


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    sub = SUBMISSION.read_text()
    status = STATUS.read_text()
    mvp = MVP.read_text() if MVP.exists() else ""
    deck = DECK.read_text() if DECK.exists() else ""
    pitch = PITCH.read_text() if PITCH.exists() else ""
    brief = BRIEF.read_text() if BRIEF.exists() else ""

    print("ACR claim audit — do the docs still tell the truth?")
    if FAST:
        print("  (CLAIMS_FAST — forge/terminal re-runs skipped; python count still measured)")

    print("\ntest counts")
    # Suites only ever grow here, and a doc that UNDERSTATES the suite is still
    # a doc that is wrong — this is the drift that actually happened, five
    # times over, and every instance was an undercount.
    # `costly` decides what CLAIMS_FAST is allowed to skip. The python count is
    # NOT costly — `--collect-only` executes nothing — so skipping it bought a
    # second and cost the audit its sharpest check: CI ran green for days over
    # docs that said 248 against a suite of 260, because the one measurement
    # that would have caught it was the one FAST turned off. Only `forge test`
    # and `npm test`, which genuinely re-run suites other CI jobs already ran,
    # are worth skipping.
    # Every doc that states the number is held to it individually. The first
    # version of this loop took the FIRST doc that made a claim and stopped —
    # so with SUBMISSION correct at 303, MVP_STATUS sat at 230 for a week and
    # the check that existed to catch exactly that passed green.
    for label, pattern, measure, texts, costly in (
        ("python suite", r"\*\*(\d+) passed\*\*", measured_pytest,
         (("SUBMISSION", sub), ("STATUS", status), ("MVP_STATUS", mvp)), False),
        ("forge suite", r"\*\*(\d+) passed\*\*.*?oracle", measured_forge,
         (("SUBMISSION", sub),), True),
        ("terminal suite", r"\*\*(\d+)/\d+ node tests\*\*", measured_terminal,
         (("SUBMISSION", sub),), True),
        # The subgraph mappings are the Graph track's whole claim; a suite that
        # nothing measures is a suite that quietly stops running.
        ("subgraph suite", r"\*\*(\d+) matchstick\*\*", measured_matchstick,
         (("SUBMISSION", sub),), True),
    ):
        stated = [(name, c) for name, t in texts if (c := claim(t, pattern)) is not None]
        if not stated:
            check(False, f"{label}: no claim found in the docs — has it been reworded?")
            continue
        if FAST and costly:
            print(f"  · {label}: claims {stated[0][1]} (not measured)")
            continue
        actual = measure()
        if actual is None:
            check(False, f"{label}: could not measure (toolchain missing?)")
            continue
        for name, val in stated:
            check(actual == val, f"{label}: {name} says {val}, measured {actual}")

    # The deck states the same suite sizes in its own phrasing ("**273 py** ·
    # **50 forge** · **55 terminal** … glossary **386/386**). It is a separate
    # sentence from SUBMISSION's table, so it drifts separately — and it is the
    # one a judge reads. Same measurements, parsed from the deck's own wording.
    print("\nthe deck (docs/presentation.md — what a judge actually reads)")
    if not deck:
        check(False, "presentation.md is missing")
    else:
        for label, pattern, measure, costly in (
            ("deck python count", r"\*\*(\d+) py\*\*", measured_pytest, False),
            ("deck forge count", r"\*\*(\d+) forge\*\*", measured_forge, True),
            ("deck terminal count", r"\*\*(\d+) terminal\*\*", measured_terminal, True),
            ("deck glossary count", r"glossary \*\*(\d+)/\d+\*\*", measured_glossary, False),
        ):
            stated = claim(deck, pattern)
            if stated is None:
                check(False, f"{label}: no claim found — has the deck been reworded?")
                continue
            if FAST and costly:
                print(f"  · {label}: claims {stated} (not measured)")
                continue
            actual = measure()
            if actual is None:
                check(False, f"{label}: could not measure (toolchain missing?)")
                continue
            check(actual == stated, f"{label}: deck says {stated}, measured {actual}")
        # A deck that narrates a series the venue has already rolled past sends a
        # judge to /curve expecting one thing and showing another.
        check(
            "series 0" not in deck.lower(),
            "the deck does not narrate the venue's first, long-settled series",
        )

    # The eight-slide pitch deck states the same suite sizes on its proof
    # slide, in its own markup (`<b>367</b> py`). Same measurements, parsed
    # from that markup — the lesson at the top of this block was that a deck
    # goes stale for exactly as long as nothing parses it, and this one is
    # generated into a PDF, where a wrong number outlives every redeploy.
    print("\nthe pitch deck (docs/pitch/deck.html — the one actually presented)")
    if not pitch:
        check(False, "docs/pitch/deck.html is missing")
    else:
        for label, pattern, measure, costly in (
            ("pitch python count", r"<b>(\d+)</b> py\b", measured_pytest, False),
            ("pitch forge count", r"<b>(\d+)</b> forge\b", measured_forge, True),
            ("pitch terminal count", r"<b>(\d+)</b> terminal\b", measured_terminal, True),
            ("pitch glossary count", r"<b>(\d+)</b>/\d+ glossary\b", measured_glossary, False),
        ):
            stated = claim(pitch, pattern)
            if stated is None:
                check(False, f"{label}: no claim found — has the proof slide been reworded?")
                continue
            if FAST and costly:
                print(f"  · {label}: claims {stated} (not measured)")
                continue
            actual = measure()
            if actual is None:
                check(False, f"{label}: could not measure (toolchain missing?)")
                continue
            check(actual == stated, f"{label}: the pitch deck says {stated}, measured {actual}")

    # The submission brief is markdown, states the counts in the long deck's
    # phrasing, and carries one extra promise the others don't: no connector
    # dashes in its content (the product's own name is the single exception).
    # That was a review requirement, so it is held here rather than remembered.
    print("\nthe submission brief (docs/SUBMISSION-BRIEF.md — the form's source of truth)")
    if not brief:
        check(False, "docs/SUBMISSION-BRIEF.md is missing")
    else:
        for label, pattern, measure, costly in (
            ("brief python count", r"\*\*(\d+) py\*\*", measured_pytest, False),
            ("brief forge count", r"\*\*(\d+) forge\*\*", measured_forge, True),
            ("brief terminal count", r"\*\*(\d+) terminal\*\*", measured_terminal, True),
            ("brief glossary count", r"glossary \*\*(\d+)/\d+\*\*", measured_glossary, False),
        ):
            stated = claim(brief, pattern)
            if stated is None:
                check(False, f"{label}: no claim found — has the counts row been reworded?")
                continue
            if FAST and costly:
                print(f"  · {label}: claims {stated} (not measured)")
                continue
            actual = measure()
            if actual is None:
                check(False, f"{label}: could not measure (toolchain missing?)")
                continue
            check(actual == stated, f"{label}: the brief says {stated}, measured {actual}")
        residue = brief.replace("ACR — Arc Compute Rate", "")
        check(
            "—" not in residue and "–" not in residue,
            "the brief keeps its no-connector-dash rule (the product name is the one exception)",
        )

    print("\nglossary")
    stated = claim(sub, r"(\d+)/\d+ diagram terms")
    if stated is None:
        check(False, "glossary: no claim found in SUBMISSION.md")
    else:
        actual = measured_glossary()
        if actual is None:
            check(False, "glossary: could not measure")
        else:
            check(actual == stated, f"glossary: docs say {stated}, measured {actual}")

    print("\nthe architecture diagram (Readme calls it implementation-accurate)")
    canvas = diagram_suite_claims(DIAGRAM)
    svg = diagram_suite_claims(DIAGRAM_SVG)
    if not canvas:
        check(False, "diagram: no '<n> py · <n> forge · <n> terminal · <n> agent' "
                     "claim found — has a card been reworded?")
    else:
        # Both cheap, and both on even under CLAIMS_FAST: they catch a skipped
        # `make diagram` / `make deck`, which is how the SVG kept 289 after the
        # canvas was fixed. Neither runs a suite.
        check(len(set(canvas)) == 1,
              f"diagram: its two cards agree with each other {sorted(set(canvas))}")
        check(sorted(set(svg)) == sorted(set(canvas)),
              f"diagram: docs/assets/*.svg matches the canvas (svg says {sorted(set(svg))})")
        py, forge, term, _agent = canvas[0]
        for label, stated, measure, costly in (
            ("diagram python count", py, measured_pytest, False),
            ("diagram forge count", forge, measured_forge, True),
            ("diagram terminal count", term, measured_terminal, True),
        ):
            if FAST and costly:
                print(f"  · {label}: claims {stated} (not measured)")
                continue
            actual = measure()
            if actual is None:
                check(False, f"{label}: could not measure (toolchain missing?)")
                continue
            check(actual == stated, f"{label}: diagram says {stated}, measured {actual}")

    print("\nthe receipts archive (the number four docs quote and nothing measured)")
    # This rotted to 11 in three places while the archive held 31, for the
    # dullest possible reason: no check read the file. The suite counts, the
    # glossary and the CI shape were all measured; the one number a judge is
    # most likely to spot-check by opening the ledger was not.
    ledger = ROOT / "services" / "index_api" / "index_api" / "receipts_live.jsonl"
    rows, payers = [], {}
    for ln in (ledger.read_text().splitlines() if ledger.exists() else []):
        if not ln.strip():
            continue
        try:
            # Parsed, not counted. A line that is not JSON is not a receipt, and
            # a total that includes it is the same soft number this file exists
            # to kill.
            who = str(json.loads(ln).get("payer", "")).lower()
        except Exception:
            continue
        rows.append(ln)
        payers[who] = payers.get(who, 0) + 1
    readme = README.read_text() if README.exists() else ""
    for name, text, pattern in (
        ("SUBMISSION", sub, r"\*\*(\d+) Gateway-settled receipts\*\*"),
        ("STATUS", status, r"receipts_live\.jsonl`, (\d+) rows"),
        ("Readme", readme, r"\*\*(\d+)\*\* real Gateway x402 settlements"),
    ):
        stated = claim(text, pattern)
        if stated is None:
            check(False, f"receipts: no count found in {name} — has it been reworded?")
        else:
            check(stated == len(rows), f"receipts: {name} says {stated}, the archive holds {len(rows)}")
    # "Two distinct payers" is the claim carrying the honesty here — revenue
    # from one wallet we control would prove plumbing rather than demand — so
    # it is the one worth a gate of its own.
    # Spelled, not numeric: SUBMISSION opens the paragraph "**Two distinct
    # payers** have settled…", and prose is the right call there. Match the word
    # rather than forcing a digit into the sentence to suit the checker.
    m = re.search(r"\*\*(\d+|[A-Za-z]+) distinct payers\*\*", sub)
    WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
    raw = m.group(1).lower() if m else None
    stated_payers = (
        int(raw) if raw and raw.isdigit() else WORDS.get(raw) if raw else None
    )
    if stated_payers is None:
        check(False, "receipts: SUBMISSION states no payer count I can parse")
    else:
        check(stated_payers == len(payers),
              f"receipts: SUBMISSION says {stated_payers} payer(s), the archive has {len(payers)}")

    print("\nCI shape")
    stated_jobs = claim(sub, r"(\d+)/\d+ jobs green")
    jobs = measured_ci_jobs()
    if stated_jobs is None:
        check(False, "CI: no '<n>/<n> jobs green' claim found in SUBMISSION.md")
    else:
        check(jobs == stated_jobs, f"CI jobs: docs say {stated_jobs}, ci.yml defines {jobs}")
    # The scheduled workflows are load-bearing (the heartbeat and the lifecycle
    # roll keep the venue alive), so a doc describing only a keepalive is
    # describing a different, smaller product.
    # Names HOW the venue stays alive, not WHICH implementation. This required
    # the workflow names — and then the venue's chores moved into the in-process
    # keeper and the workflows became dispatch-only fallbacks, so the check
    # rewarded a sentence that had become false and would have gone RED the
    # moment STATUS was corrected. A gate that punishes accuracy is worse than
    # no gate.
    check(
        any(k in status for k in ("keeper", "futures-heartbeat", "futures-lifecycle")),
        f"STATUS says what keeps the venue alive ({measured_workflows()} workflow files exist)",
    )

    print("\naddresses named in the docs match the live deploy")
    from acr_core import get_settings

    s = get_settings()
    # Every contract the service is CONFIGURED to talk to, not a chosen three:
    # a live address nobody's docs name is exactly the drift this gate exists to
    # catch, and the attestor sat outside it for months.
    for label, addr in (
        ("oracle", s.oracle_address),
        ("oracle v2", getattr(s, "oracle_v2_address", "")),
        ("registry", s.registry_address),
        ("futures venue", s.futures_address),
        ("feed-access attestor", s.attestor_address),
        ("receipt mirror", getattr(s, "receipt_mirror_address", "")),
    ):
        if not addr:
            continue
        # Case-insensitive: the docs checksum some and lowercase others.
        named = addr.lower() in sub.lower() or addr.lower() in status.lower()
        check(named, f"{label} {addr[:12]}… appears in the docs")

    print("\nstale-statement guards")
    # These are prose, not numbers, and both were true once. A claim that has
    # become false is worse than one that was never made: it is read as current.
    check(
        "do not trust the current `.env`" not in status,
        "STATUS no longer says the repo .env holds broken placeholders "
        "(it is what drives every real transaction now)",
    )
    check(
        "never folded in" not in status,
        "STATUS no longer says the real Gateway receipts were never folded into the bundle",
    )
    # MVP_STATUS's own retired sentences. Each was accurate the day it was
    # written and quietly became a lie: the .env is real now, the instrument
    # layer trades hourly, the Marketplace form went in on 2026-08-04, and the
    # commit count was off by 3.5x. The phrase is the tombstone; if it comes
    # back, so has the lie.
    for phrase, why in (
        ("broken placeholder values", "the repo .env is real now"),
        ("half-built", "the instrument layer trades hourly across three books"),
        ("not yet done", "the Marketplace form was submitted 2026-08-04"),
    ):
        check(phrase not in mvp, f"MVP_STATUS no longer says '{phrase}' — {why}")
    check(
        re.search(r"~?\d+ commits", mvp) is None,
        "MVP_STATUS states no commit count — it drifts daily and nothing measures it",
    )

    # The venue's SHAPE. Every number above is checked by measurement, and the
    # one thing no measurement covered was how many books exist — so when the
    # venue went from one index to three, every doc describing a single
    # ACR-INF series passed this audit clean, including one that still called
    # the instrument layer "not live-traded" while it traded hourly.
    #
    # Phrases, not counts, because the count needs a chain read this file
    # deliberately does not do. Each of these was true once, which is exactly
    # what makes it dangerous: a judge reads it as current.
    print("\nthe venue's shape (three books since 2026-08-04)")
    from pathlib import Path as _P

    STALE_VENUE = {
        "not live-traded": "the instrument layer trades hourly across three books",
        "series 0 seeded": "the venue is well past series 0",
        "a live acr-inf series": "there are three live series, not one",
    }
    for doc in ("SUBMISSION.md", "IMPLEMENTATION_STATUS.md", "MVP_STATUS.md", "presentation.md",
                "PITCH.md", "SUBMISSION-BRIEF.md"):
        body = (_P("docs") / doc).read_text().lower() if (_P("docs") / doc).exists() else ""
        for phrase, why in STALE_VENUE.items():
            check(phrase not in body, f"{doc} no longer says '{phrase}' — {why}")

    # --- the continuity diff stats -------------------------------------------
    # Measured over the FROZEN range the document names, never against HEAD. A
    # statistic anchored to a moving head is stale the moment the commit that
    # corrects it lands, which is the loop this check exists to break.
    if CONTINUITY.exists():
        body = CONTINUITY.read_text()
        m = re.search(r"git diff --shortstat (\S+\.\.\S+)", body)
        if check(m is not None, "CONTINUITY.md names the range its statistics cover"):
            rng = m.group(1)
            # EVERY range in the document, not just the first. Checking one was a
            # real hole: the table was frozen while §7 — the section telling a
            # reader how to re-derive it — still said `..HEAD`, so a judge
            # following the document's own instructions got figures contradicting
            # it, and this check stayed green because it only ever looked at the
            # first match. A document that disagrees with itself in the honesty
            # section is worse than one that is merely stale.
            ranges = {r.strip("`),.") for r in re.findall(r"\S+\.\.\S+", body)}
            floating = sorted(r for r in ranges if "HEAD" in r)
            if check(not floating,
                     "CONTINUITY.md anchors EVERY range to a fixed sha, not HEAD"
                     + (f" — floating: {', '.join(floating)}" if floating else f" ({rng})")):
                # Every one of these must succeed or none of them is a
                # measurement. A shallow checkout has neither the tag nor the
                # history, and comparing against git's refusal is how this
                # reported six false STALE claims.
                log_l = git_lines(["log", "--oneline", rng])
                short_l = git_lines(["diff", "--shortstat", rng])
                added_l = git_lines(["diff", "--name-status", "--diff-filter=A", rng])
                num_l = git_lines(["diff", "--numstat", "--diff-filter=A", rng])
                if None in (log_l, short_l, added_l, num_l):
                    check(
                        False,
                        f"continuity: git cannot resolve {rng} here, so the figures "
                        "were NOT measured — this needs the full history and tags "
                        "(actions/checkout fetch-depth: 0), not a doc edit",
                    )
                else:
                    short = "\n".join(short_l or [])
                    added = len(added_l or [])
                    newlines = sum(
                        int(line.split("\t")[0])
                        for line in (num_l or [])
                        if line.split("\t")[0].isdigit()
                    )
                    commits = len(log_l or [])

                    def _n(pattern: str, text: str) -> int | None:
                        hit = re.search(pattern, text)
                        return int(hit.group(1).replace(",", "")) if hit else None

                    measured = {
                        "commits": commits,
                        "files changed": _n(r"(\d+) files? changed", short),
                        "insertions": _n(r"(\d+) insertion", short),
                        "deletions": _n(r"(\d+) deletion", short),
                        "files added": added,
                        "lines in new files": newlines,
                    }
                    stated = {
                        "commits": _n(r"# ([\d,]+) commits", body),
                        "files changed": _n(r"\| files changed \| \*?\*?([\d,]+)", body),
                        "insertions": _n(r"\| insertions \| \*\*([\d,]+)\*\*", body),
                        "deletions": _n(r"\| deletions \| \*\*([\d,]+)\*\*", body),
                        "files added": _n(r"\| files added \| \*\*([\d,]+)\*\*", body),
                        "lines in new files": _n(r"\| lines in new files \| \*\*([\d,]+)\*\*", body),
                    }
                    for label, want in measured.items():
                        got = stated[label]
                        check(got == want,
                              f"continuity {label}: CONTINUITY.md says {got}, measured {want}")

                    # The derived headline — the document's opening sentence, and the
                    # single most-read claim in it.
                    ins, new_lines = measured["insertions"], measured["lines in new files"]
                    if ins:
                        want_share = f"{new_lines / ins * 100:.1f}%"
                        hit = re.search(r"\*\*([\d.]+%) of the lines added", body)
                        check(hit is not None and hit.group(1) == want_share,
                              f"continuity new-file share: CONTINUITY.md says "
                              f"{hit.group(1) if hit else 'nothing'}, measured {want_share}")

    # --- on-chain evidence: no two hashes may differ by one character --------
    #
    # A settled transaction hash in docs/PITCH.md was corrupted from
    # 0x5351bd0c… to 0x5551bd0c… by a count bump that replaced a bare `535` with
    # `555`. The commit that did it asserted the edits were anchored and verified
    # that the settled PRICE was untouched — which was true, and useless: 0.49533
    # contains `533`, so the transition that caused the damage was the one nobody
    # checked for. Verifying one instance and reporting the class is the whole
    # failure.
    #
    # This catches the class instead. Two long hex strings in one corpus differing
    # by exactly one character is never a legitimate state: either the same fact
    # is cited two ways, or one of them has been edited by something that could
    # not tell a hash from a number. It needs no network, so it holds in CI and it
    # holds for hashes too old for the RPC to resolve — which is most of them,
    # measured: a transaction from today is retrievable and one from August is not.
    print("\nevidence integrity")
    tokens: dict[str, set[str]] = {}
    # .svg is deliberate, not thorough-for-its-own-sake: submission-brief.html
    # EMBEDS docs/assets/*.svg, so the brief carried a stale figure long after its
    # own prose was right. A guard that reads only sources cannot see that path.
    scanned = [
        q
        for pattern in ("*.md", "*.html", "*.svg")
        for q in sorted((ROOT / "docs").rglob(pattern))
    ]
    for path in scanned:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:  # pragma: no cover - unreadable file reports as no tokens
            continue
        for tok in re.findall(r"0x[0-9a-fA-F]{8,}", text):
            tokens.setdefault(tok.lower(), set()).add(str(path.relative_to(ROOT)))

    divergent: list[str] = []
    keys = sorted(tokens)
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            if len(a) != len(b):
                continue
            if sum(1 for x, y in zip(a, b, strict=True) if x != y) == 1:
                divergent.append(
                    f"{a[:14]}… ({', '.join(sorted(tokens[a]))}) vs "
                    f"{b[:14]}… ({', '.join(sorted(tokens[b]))})"
                )
    check(not divergent,
          f"no two on-chain identifiers under docs/ differ by one character "
          f"({len(keys)} scanned across sources AND generated artifacts)")
    for d in divergent:
        print(f"      {d}")

    print()
    if _failures:
        print(f"claims: {len(_failures)} STALE — the docs are ahead of, or behind, reality")
        for f in _failures:
            print(f"    ✗ {f}")
        sys.exit(1)
    print("claims: EVERY DOCUMENTED NUMBER STILL HOLDS")
    sys.exit(0)


if __name__ == "__main__":
    main()
