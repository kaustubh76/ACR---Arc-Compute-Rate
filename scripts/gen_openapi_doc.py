#!/usr/bin/env python3
"""Render docs/acr-openapi.md from the live OpenAPI schema — which is what that
file has claimed to be since it was written, and never was.

    uv run python scripts/gen_openapi_doc.py            # rewrite the doc
    uv run python scripts/gen_openapi_doc.py --check    # exit 1 if it is stale

THE FILE WAS A HAND-EDITED DOC WEARING A GENERATED ONE'S LABEL. docs/README.md says
"rendered from the live OpenAPI 3.1 schema"; there was no script, no Makefile
target, and the one commit that touched it added a single line by hand. It listed
24 routes when the service had 43 — every route added since the hedger, including
the whole agent gate, was simply absent from "the endpoint reference". The house
rule at Makefile `deck:` names this exact shape: a generated file with an
unrecorded recipe is a hand-edited file that nobody admits to.

Source of truth is `app.openapi()` — the same object `tests/test_endpoint_register_
parity.py` reads — so this cannot disagree with the service. The paid/free split
comes from GATED_ENDPOINTS, the list `/x402/info` serves, not from a second copy.
`--check` makes staleness a CI failure like `golden-check` and `anchors-check`.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "acr-openapi.md"
API = "https://acr-api-1fto.onrender.com"

#: Routes the reference deliberately omits, each with the reason. Mirrors the
#: exclusion dict in tests/test_endpoint_register_parity.py: an operator surface
#: and a seller's metered endpoint are not things a reader types.
OMIT = {
    "/ops/verify": "operator console, token-gated",
    "/ops/actions": "operator console, token-gated, spends money",
}

#: Paid, but absent from GATED_ENDPOINTS — a pre-existing drift this file must not
#: inherit. `/compute/{label}` depends on `require_payment` and prices per seller,
#: yet `/x402/info` does not list it (test_marketplace pins GATED_ENDPOINTS to the
#: index-shaped ENDPOINT_FAMILIES, and the terminal register excludes it on purpose
#: as a route a buyer agent reaches through the catalog rather than types). Listing
#: it as free here would be false, so it is named paid from this side until the
#: service-side list is reconciled.
PAID_BUT_UNADVERTISED = {"/compute/{label}"}


def render() -> str:
    from index_api.app import GATED_ENDPOINTS, app, price_usdc

    spec = app.openapi()
    paths = spec["paths"]
    gated = set(GATED_ENDPOINTS) | PAID_BUT_UNADVERTISED

    def lines(paid: bool) -> list[str]:
        out = []
        for path in sorted(paths):
            if path in OMIT or (path in gated) != paid:
                continue
            for method, op in sorted(paths[path].items()):
                summary = str(op.get("summary") or "").strip() or path.strip("/").replace("/", " ").title()
                m = method.upper()
                out.append(f"**`{m} {path}`** — {summary}" if paid else f"`{m} {path}` — {summary}")
        return out

    paid, free = lines(True), lines(False)
    price = price_usdc()
    return "\n".join([
        "---",
        "marp: true",
        "paginate: true",
        "---",
        "",
        f"# {spec['info']['title']}",
        f"## OpenAPI {spec['openapi']} · endpoint reference",
        "",
        f"Live spec: `{API}/openapi.json`",
        f"Catalog: `{API}/marketplace/catalog`",
        "",
        f"Index endpoints: **${price} USDC per request**, x402 `exact` scheme,",
        "Circle Gateway (GatewayWalletBatched), network `eip155:5042002` (Arc).",
        "Fleet sellers (`/compute/{label}`) price per unit; the catalog carries each one's terms.",
        "",
        "Agent-to-agent calls may present an `AGENT-CARD` (see `GET /agent/challenge`);",
        "carded tape reads pass Google Cloud Model Armor in both directions (`GET /armor/info`).",
        "",
        "---",
        "",
        f"## Paid endpoints (x402-gated) · {len(paid)}",
        "",
        *paid,
        "",
        "---",
        "",
        f"## Free endpoints (no payment required) · {len(free)}",
        "",
        *free,
        "",
        "---",
        "",
        f"*Rendered by `scripts/gen_openapi_doc.py` from `app.openapi()` — {len(paid) + len(free)} routes;*",
        f"*{len(OMIT)} operator routes omitted on purpose. `make openapi-doc-check` fails when this is stale.*",
        "",
    ])


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = OUT.read_text() if OUT.exists() else ""
        if current != text:
            print(f"✗ {OUT.relative_to(ROOT)} is stale — run `make openapi-doc`")
            return 1
        print(f"✓ {OUT.relative_to(ROOT)} matches app.openapi()")
        return 0
    OUT.write_text(text)
    routes = sum(1 for ln in text.splitlines() if ln.startswith(("`GET ", "`POST ", "**`GET ", "**`POST ")))
    print(f"wrote {OUT.relative_to(ROOT)}: {routes} routes from app.openapi()")
    return 0


if __name__ == "__main__":
    sys.exit(main())
