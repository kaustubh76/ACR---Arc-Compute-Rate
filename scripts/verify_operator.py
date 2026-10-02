#!/usr/bin/env python3
"""Prove the deployed operator surfaces — one exit code.

    uv run python scripts/verify_operator.py
    VERIFY_TERMINAL_URL=http://127.0.0.1:3000 uv run python scripts/verify_operator.py

`verify_live.py` proves the seller and `verify_loop.py` proves the /loop page's
instruments. This proves the three surfaces a Tameion reviewer will open: the
business list, one business's Spend Statement, and its beancount ledger.

IT CHECKS THE HONESTY PROPERTIES, not just the status codes, because a 200 on a
page that quietly says the wrong thing is the failure that matters here:

  * the statement never carries `overpaid_usdc` — the index's dollar figure,
    which `anchors/GAP.md` puts 20x to 1159x off market and which would read as
    money on an owner's page;
  * the traction payload reports mainnet and testnet apart, with no field
    adding them;
  * `moved_usdc` and `priced_usdc` are both present, because collapsing them
    into one number is the most tempting lie on a traction page;
  * every served ledger balances — each transaction's postings sum to zero;
  * an unconsented business is never named, and an unknown one 404s rather
    than returning an empty statement that reads as "has spent nothing".

Nothing here spends and nothing here needs a key: every surface it touches is a
free read, which is the point of them.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

TERMINAL = os.environ.get(
    "VERIFY_TERMINAL_URL", "https://arc-compute-rate.vercel.app"
).rstrip("/")
TIMEOUT_S = 45.0

_failures: list[str] = []


def check(ok: bool, label: str) -> bool:
    print(f"  {'✓' if ok else '✗'} {label}")
    if not ok:
        _failures.append(label)
    return ok


def _fetch(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as exc:
        print(f"    ({exc})")
        return 0, ""


def get(path: str) -> tuple[int, str]:
    """Fetch one surface from whichever host is being verified.

    The Next app serves `/api/operator/...` and the press serves
    `/operator/...`, so the same script has to work against either: pointed at
    the deployed terminal it goes through the proxy, pointed at a press it goes
    direct. Tries the given path, and on a 404 tries the other prefix — which is
    also the honest way to tell "this surface is missing" from "I asked the
    wrong host".
    """
    status, body = _fetch(TERMINAL + path)
    if status == 404:
        alt = path[4:] if path.startswith("/api/") else "/api" + path
        # A press answers `/operator/statement/{slug}`; the proxy takes a query.
        alt = alt.replace("/operator/statement?business=", "/operator/statement/")
        s2, b2 = _fetch(TERMINAL + alt)
        if s2 != 404:
            return s2, b2
    return status, body


def balance_problems(text: str) -> list[str]:
    """Re-implemented here on purpose.

    Importing the exporter's own checker would let a bug in it pass its own
    output. This reads the SERVED file with an independent pair of eyes, which
    is the only version of the check worth running against a deployment.
    """
    import re

    problems: list[str] = []
    header: str | None = None
    postings: list[float] = []

    def close() -> None:
        if header is None:
            return
        if not postings:
            problems.append(f"{header}: no postings")
        elif round(sum(postings), 6) != 0:
            problems.append(f"{header}: sums to {sum(postings):+.6f}")

    for line in text.splitlines():
        if re.match(r"^\d{4}-\d{2}-\d{2}\s+\*", line):
            close()
            header, postings = line.strip(), []
            continue
        if re.match(r"^\d{4}-\d{2}-\d{2}\s+\S", line) or line.startswith("option"):
            close()
            header, postings = None, []
            continue
        if header is not None and line.startswith("  "):
            m = re.search(r"(-?\d+\.\d+)\s+USDC\s*$", line)
            if m:
                postings.append(float(m.group(1)))
    close()
    return problems


def main() -> int:
    print(f"operator surfaces on {TERMINAL}\n")

    print("the business list")
    status, body = get("/api/operator/businesses")
    if not check(status == 200, f"/api/operator/businesses answers ({status})"):
        return _done()
    env = json.loads(body) if body else {}
    # The proxy wraps its payload in {live, data}; the press returns it bare.
    # Unwrapping defensively lets one script verify both.
    data = env.get("data") if isinstance(env.get("data"), dict) else env
    rows = data.get("businesses") or []
    counts = data.get("counts") or {}
    if "live" in env:
        check(env.get("live") is True, "it is answering live, not from a bundle")
    check(
        counts.get("businesses") == len(rows),
        f"the count matches the rows beside it ({counts.get('businesses')} = {len(rows)})",
    )
    check(
        all(("name" in r) == bool(r.get("consented")) for r in rows),
        "a business is named only where it consented",
    )

    print("\nthe traction figures")
    status, body = get("/api/operator/traction")
    if check(status == 200, f"/api/operator/traction answers ({status})"):
        raw = json.loads(body) or {}
        t = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        by_chain = t.get("by_chain") or {}
        work = t.get("work") or {}
        check("total" not in by_chain and "all" not in by_chain,
              "no field adds mainnet and testnet together")
        check(
            all({"moved_usdc", "priced_usdc"} <= set(v) for v in by_chain.values()),
            "moved and priced are both reported, never collapsed into one",
        )
        check("decided" in work and "escalated" in work,
              "decided and escalated are two numbers, not a ratio")

    if not rows:
        print("\nno businesses onboarded yet — nothing further to prove, and that")
        print("is a true state rather than a broken one.")
        return _done()

    slug = rows[0]["slug"]
    print(f"\nthe statement for {slug}")
    status, body = get(f"/api/operator/statement?business={slug}")
    if check(status == 200, f"/api/operator/statement answers ({status})"):
        blob = body
        raw = json.loads(body) or {}
        st = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        check("overpaid_usdc" not in blob,
              "the index's dollar figure is absent (anchors/GAP.md puts it 20-1159x off market)")
        ctx = st.get("market_context") or {}
        if ctx.get("available"):
            check("bp only" in str(ctx.get("basis", "")),
                  "the index appears as basis points, labelled as such")
        check("escalations" in st and isinstance(st["escalations"], list),
              "the queue a person has to act on is present")
        check(bool((st.get("spend") or {}).get("decisions") is not None),
              "the period summary is present")

    print(f"\nthe ledger for {slug}")
    status, text = get(f"/operator/ledger/{slug}")
    if status != 200:
        # The ledger is served by the press, not the Next app, so a terminal-only
        # target will not have it. Say which, rather than failing obscurely.
        print(f"    (not served at {TERMINAL}; the ledger lives on the press)")
    else:
        check('option "operating_currency" "USDC"' in text, "it is a beancount file")
        problems = balance_problems(text)
        check(not problems, f"every transaction balances ({len(problems)} problem(s))")
        for p in problems[:3]:
            print(f"      {p}")
        check("Income" not in text,
              "no invented credit: a reroute moved no money and is not a transaction")
        check("1970-01-01" not in text, "no account opened at the Unix epoch")

    print("\nthe refusals")
    status, _ = get("/api/operator/statement?business=definitely-not-a-business")
    check(status in (404, 422), f"an unknown business is refused, not answered empty ({status})")
    status, _ = get("/api/operator/statement?business=../etc/passwd")
    check(status in (400, 404, 422), f"a path-shaped business is rejected ({status})")

    return _done()


def _done() -> int:
    print()
    if _failures:
        print(f"{len(_failures)} FAILED:")
        for f in _failures:
            print(f"  ✗ {f}")
        return 1
    print("every operator surface holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
