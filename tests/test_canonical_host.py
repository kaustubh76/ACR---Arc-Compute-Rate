"""One canonical host, named in four places that cannot see each other.

Moving the Terminal to `arccomputerate.in` put the same hostname in four files,
in three languages, and nothing compared them:

    apps/terminal/app/layout.tsx    `metadataBase` -- with
                                    `alternates: {canonical: "./"}` this is what
                                    EVERY page's canonical URL is built from
    apps/terminal/app/robots.ts     the `host:` directive in /robots.txt
    services/index_api/.../marketplace.py
                                    `PROVIDER_WEBSITE`, which reaches Circle
                                    Discovery and is the address a crawler follows
    render.yaml                     `ACR_CORS_ORIGINS` on the mainnet service

A disagreement between the first two is a site that has half-moved: every page
claims one canonical host while robots.txt names another, and a crawler resolves
that by believing neither. A disagreement with the third points discovery traffic
at the old address. None of those fail a build, a type-check or any other gate.

THE FOURTH IS THE ONE THAT BREAKS A FEATURE, and it is the reason this file
checks CORS at all. Every read in the Terminal goes through its own `/api/*`
proxies, so a wrong CORS list breaks nothing a visitor sees first. But
`lib/apiBase.ts`'s `sellerBase()` exists precisely so the BROWSER pays the press
directly, and `lib/walletPayer.ts` reads `PAYMENT-REQUIRED` and
`PAYMENT-RESPONSE` off that cross-origin response -- the two headers `app.py`'s
`expose_headers` names. An origin missing from `ACR_CORS_ORIGINS` therefore takes
out exactly two controls, pay-with-wallet on `/developers` and the `/curve` shop
floor, and leaves the whole rest of the site working. That is the shape of
breakage nobody finds from the front door.

Python reads the TypeScript and the YAML for the reason
`test_endpoint_register_parity.py` gives: only Python can import the press
constant, and the alternative is a fourth copy of the hostname in a test.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TERMINAL = ROOT / "apps" / "terminal"

#: Scheme and host only, no trailing slash. Everything below is compared against
#: `marketplace.PROVIDER_WEBSITE`, which is the one of the four that is a plain
#: Python string a test can import rather than a pattern it has to scrape.
_HOST = re.compile(r"https://[a-z0-9.-]+", re.I)


def _canonical() -> str:
    from index_api.marketplace import PROVIDER_WEBSITE

    return PROVIDER_WEBSITE.rstrip("/")


def _one(path: Path, pattern: str) -> str:
    """The single host a file names, or a failure that says which file."""
    src = path.read_text(encoding="utf-8")
    found = re.findall(pattern, src)
    assert len(found) == 1, (
        f"{path.relative_to(ROOT)}: expected exactly one match for {pattern!r}, "
        f"found {len(found)} -- the pattern has drifted from the file"
    )
    return found[0].rstrip("/")


def test_the_terminal_canonical_matches_the_provider_website() -> None:
    """`metadataBase` against the address discovery hands out.

    These two are the pair most likely to diverge, because they live in
    different languages and are edited for different reasons: one when somebody
    thinks about SEO, the other when somebody thinks about Circle's crawler.
    """
    canonical = _canonical()
    meta = _one(TERMINAL / "app" / "layout.tsx", r'metadataBase: new URL\("(https://[^"]+)"\)')
    assert meta == canonical, (
        f"layout.tsx canonicalises every page to {meta} while the provider catalog "
        f"sends crawlers to {canonical}"
    )


def test_robots_names_the_same_host_as_every_canonical_tag() -> None:
    """A robots.txt naming a different host than the canonical tags is a site
    that has half-moved, and a crawler resolves the contradiction by believing
    neither."""
    canonical = _canonical()
    host = _one(TERMINAL / "app" / "robots.ts", r'host: "(https://[^"]+)"')
    assert host == canonical, f"robots.txt says {host}, the canonical tags say {canonical}"


def test_the_docs_url_is_the_canonical_host_too() -> None:
    """`PROVIDER_DOCS_URL` is where a crawler is sent to READ. It must not be
    left on a host the rest of the deployment has moved off."""
    from index_api.marketplace import PROVIDER_DOCS_URL

    canonical = _canonical()
    assert PROVIDER_DOCS_URL.startswith(canonical + "/"), (
        f"PROVIDER_DOCS_URL is {PROVIDER_DOCS_URL}, which is not on {canonical}"
    )


def test_mainnet_cors_names_the_canonical_origin() -> None:
    """The one that silently breaks the wallet path.

    Asserted against `render.yaml` rather than the live service, because the
    file is what a deploy applies and a test cannot read Render's env. The
    service itself is checked by `verify_live.py` against a real response.
    """
    import yaml

    doc = yaml.safe_load((ROOT / "render.yaml").read_text(encoding="utf-8"))
    mainnet = [s for s in doc["services"] if s.get("name") == "acr-api-mainnet"]
    assert mainnet, "acr-api-mainnet is not in render.yaml"
    env = {e["key"]: e.get("value") for e in (mainnet[0].get("envVars") or [])}
    raw = env.get("ACR_CORS_ORIGINS")
    assert raw, "the mainnet service declares no ACR_CORS_ORIGINS"

    # Split the way `app.py` does, so this test agrees with the code that acts.
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    canonical = _canonical()
    assert canonical in origins, (
        f"{canonical} is not in ACR_CORS_ORIGINS {origins} -- pay-with-wallet on "
        f"/developers and the /curve shop floor would fail with a CORS error while "
        f"every other surface kept working"
    )
    # There is no `allow_origin_regex` anywhere in the repo, so matching is an
    # exact string and the apex does NOT cover www.
    host = canonical.removeprefix("https://")
    assert f"https://www.{host}" in origins, (
        f"https://www.{host} is not in {origins}. www 307s to the apex for page "
        f"loads, but a cross-origin fetch is refused before any redirect is "
        f"followed, so www needs listing in its own right"
    )


def test_the_wildcard_the_guard_would_accept_is_not_in_use() -> None:
    """`mainnet_guard` only rejects the literals "" and "*", so a LIST
    containing "*" passes it and then hands Starlette a real wildcard. The guard
    is left alone deliberately -- `test_mainnet_guard.py` asserts an exact
    violation count -- so the hole is closed here instead, where it costs
    nothing."""
    import yaml

    doc = yaml.safe_load((ROOT / "render.yaml").read_text(encoding="utf-8"))
    for svc in doc["services"]:
        raw = {e["key"]: e.get("value") for e in (svc.get("envVars") or [])}.get(
            "ACR_CORS_ORIGINS"
        )
        if not raw or svc.get("name") != "acr-api-mainnet":
            continue
        origins = [o.strip() for o in str(raw).split(",") if o.strip()]
        assert "*" not in origins, (
            f"{svc['name']}: ACR_CORS_ORIGINS contains a '*' entry, which passes "
            f"mainnet_guard's two-literal check and then allows every origin"
        )
