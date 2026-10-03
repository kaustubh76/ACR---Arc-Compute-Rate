#!/usr/bin/env python3
"""Pull the operator's live decision log into the committed archive.

    uv run python scripts/archive_decisions.py                  # append what production decided since the last archive
    uv run python scripts/archive_decisions.py --check          # exit 1 if production holds rows the archive does not
    uv run python scripts/archive_decisions.py --business acme  # one business rather than every registered one

THE SAME DISK THAT IS NOT THERE. `scripts/archive_receipts.py` exists because
the free tier has no persistent volume, so every Gateway settlement the deployed
seller records lives in container memory and a JSONL the next restart erases.
The operator writes its decisions to `data/operator_decisions.jsonl` on exactly
that disk, and nothing was pulling them in — so every decision made during the
hackathon would vanish on the next redeploy and the traction page would quietly
revert to the nine rows that ship inside the image.

Quietly is the word that matters. The page would not break; it would just report
a smaller number, which is the one failure shape nobody investigates.

HOW ROWS ARE IDENTIFIED. Receipts dedupe on `tx_ref`. A decision has no such
key: the log is append-only and the SAME obligation legitimately appears twice —
once escalated, once resolved — so the identity is the whole of
`(obligation_id, at, intent)`. Keying on `obligation_id` alone would drop every
resolution, which is precisely the half of the record that proves a human was
involved.

TRUNCATION IS A FAILURE, NOT A RESULT. The statement caps its rows, so this asks
for a cap far above the record and refuses to write if production returns
exactly that many — a full page means there may be more behind it, and an
archiver that silently stops at the cap is how a record of 400 decisions becomes
a record of 50 with nobody the wiser.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "services" / "index_api" / "index_api" / "operator_decisions.jsonl"
API = os.environ.get("ACR_API_URL", "https://acr-api-mainnet.onrender.com").rstrip("/")

#: Far above any plausible record, and the server clamps it to 1000. If a
#: business ever really has 1000 decisions in a window this script says so and
#: stops rather than writing a truncated archive over a complete one.
LIMIT = 1000
#: A year. The archive is cumulative, so the window only has to cover the gap
#: since the last run; a wide one costs a single read and removes a whole class
#: of "we redeployed late and lost a week".
DAYS = 365


def _key(row: dict) -> tuple:
    """What makes two decision rows the same row.

    `at` carries sub-second precision from `time.time()`, so two decisions about
    one obligation in the same second are still distinct. `intent` is in the key
    because an escalation and its resolution share an id by design.
    """
    return (
        str(row.get("obligation_id") or ""),
        float(row.get("at") or 0.0),
        str(row.get("intent") or ""),
    )


def _archived(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _businesses(api: str, include_sandbox: bool = False) -> list[str]:
    """Every registered business, SANDBOXES EXCLUDED.

    A sandbox's decisions are hand-written fixtures that already ship in their
    own archive (`operator_decisions.sandbox.jsonl`), kept apart so they can be
    excluded from every traction figure. Appending them to the real archive
    would merge a demonstration into the record of what the agent actually did
    for actual businesses — the one mixture this product cannot afford.
    """
    with urllib.request.urlopen(f"{api}/operator/businesses", timeout=60) as r:
        body = json.load(r)
    rows = body.get("data", body).get("businesses") or []
    return [
        str(b["slug"])
        for b in rows
        if b.get("slug") and (include_sandbox or not b.get("sandbox"))
    ]


def _live(api: str, slug: str) -> tuple[list[dict], bool]:
    """One business's decisions, newest first, and whether the page was full."""
    url = f"{api}/operator/statement/{slug}?days={DAYS}&limit={LIMIT}"
    with urllib.request.urlopen(url, timeout=120) as r:
        body = json.load(r)
    body = body.get("data", body)
    rows = list(body.get("recent") or [])
    return rows, len(rows) >= LIMIT


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--api", default=API)
    ap.add_argument("--archive", default=str(ARCHIVE))
    ap.add_argument("--business", default="", help="one slug; default is every registered one")
    ap.add_argument(
        "--check", action="store_true",
        help="report, do not write; exit 1 when production holds rows the archive does not",
    )
    a = ap.parse_args()
    path = Path(a.archive)

    have = _archived(path)
    seen = {_key(r) for r in have}
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    print(f"archive   {rel}: {len(have)} row(s)")

    slugs = [a.business] if a.business else _businesses(a.api)
    print(f"live      {a.api}: {len(slugs)} real business(es), sandboxes excluded")

    new: list[dict] = []
    truncated: list[str] = []
    for slug in slugs:
        rows, full = _live(a.api, slug)
        if full:
            truncated.append(slug)
        fresh = [r for r in reversed(rows) if _key(r) not in seen]
        for r in fresh:
            seen.add(_key(r))
        new += fresh
        print(f"  {slug:<18} {len(rows):>4} row(s), {len(fresh)} the archive does not hold")

    if truncated:
        # Refusing is the whole point. Writing what we got would leave an
        # archive that looks complete and is not, and nothing downstream could
        # tell the difference.
        print(
            f"\nREFUSING: {', '.join(truncated)} returned the full {LIMIT}-row page, "
            "so there may be more behind it. Raise LIMIT or narrow DAYS and re-run.",
            file=sys.stderr,
        )
        return 2

    print(f"missing   {len(new)} row(s) production holds that the archive does not")
    for r in new[:10]:
        print(
            f"  + {r.get('obligation_id','')[:38]:<38} {r.get('intent',''):<9} "
            f"{float(r.get('billed_usdc') or 0.0):.6f} "
            f"{'owner' if r.get('actor') == 'owner' else 'agent'}"
        )
    if len(new) > 10:
        print(f"  … and {len(new) - 10} more")

    if a.check:
        return 1 if new else 0
    if not new:
        print("nothing to do")
        return 0

    with path.open("a", encoding="utf-8") as f:
        for r in new:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    print(
        f"wrote     {len(new)} row(s); archive now {len(have) + len(new)}. "
        "Commit it, then rebuild the image."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
