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

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBMISSION = ROOT / "docs" / "SUBMISSION.md"
STATUS = ROOT / "docs" / "IMPLEMENTATION_STATUS.md"
#: The deck is the artefact a judge actually reads, and it was the most
#: drifted: it claimed 230 py / 332 glossary / 50 terminal against a suite of
#: 273 / 386 / 55, and narrated a series that had already been rolled twice.
#: It went unchecked for the dullest reason — nothing parsed it.
DECK = ROOT / "docs" / "presentation.md"
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


def claim(text: str, pattern: str) -> int | None:
    """The first integer a documented claim asserts, or None if the doc no
    longer phrases it that way — which is itself worth reporting, because a
    check silently matching nothing is a check that always passes."""
    m = re.search(pattern, text)
    return int(m.group(1).replace(",", "")) if m else None


# --- the measurements -------------------------------------------------------


def measured_pytest() -> int | None:
    """Collected, not executed — cheap, and it counts the anvil-gated tests that
    SKIP on a machine without a node. Deliberately not `-q`: that suppresses the
    very summary line this needs."""
    out = run(["uv", "run", "pytest", "packages", "services", "tests",
               "-p", "no:cacheprovider", "--collect-only"])
    m = re.search(r"(\d+)\s+tests? collected", out)
    return int(m.group(1)) if m else None


def measured_forge() -> int | None:
    """Plain `forge test` — `--summary` prints a table and moves the one-line
    total out of reach."""
    out = run(["forge", "test"], cwd=ROOT / "contracts")
    m = re.search(r"(\d+) tests? passed", out)
    return int(m.group(1)) if m else None


def measured_terminal() -> int | None:
    out = run(["npm", "test"], cwd=ROOT / "apps" / "terminal")
    m = re.search(r"^# pass (\d+)$", out, re.M)
    return int(m.group(1)) if m else None


def measured_glossary() -> int | None:
    out = run(["uv", "run", "python", "scripts/check_glossary_coverage.py"])
    m = re.search(r"all (\d+) uncommon diagram terms", out)
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
    deck = DECK.read_text() if DECK.exists() else ""

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
    for label, pattern, measure, texts, costly in (
        ("python suite", r"\*\*(\d+) passed\*\*", measured_pytest, (sub, status), False),
        ("forge suite", r"\*\*(\d+) passed\*\*.*?oracle", measured_forge, (sub,), True),
        ("terminal suite", r"\*\*(\d+)/\d+ node tests\*\*", measured_terminal, (sub,), True),
    ):
        stated = next((c for c in (claim(t, pattern) for t in texts) if c), None)
        if stated is None:
            check(False, f"{label}: no claim found in the docs — has it been reworded?")
            continue
        if FAST and costly:
            print(f"  · {label}: claims {stated} (not measured)")
            continue
        actual = measure()
        if actual is None:
            check(False, f"{label}: could not measure (toolchain missing?)")
            continue
        check(actual == stated, f"{label}: docs say {stated}, measured {actual}")

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
    for label, addr in (
        ("oracle", s.oracle_address),
        ("registry", s.registry_address),
        ("futures venue", s.futures_address),
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
    for doc in ("SUBMISSION.md", "IMPLEMENTATION_STATUS.md", "MVP_STATUS.md", "presentation.md"):
        body = (_P("docs") / doc).read_text().lower() if (_P("docs") / doc).exists() else ""
        for phrase, why in STALE_VENUE.items():
            check(phrase not in body, f"{doc} no longer says '{phrase}' — {why}")

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
