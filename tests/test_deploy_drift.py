"""The route-drift checker's own half — the half that needs no network.

`scripts/verify_deploy_drift.py` compares what this checkout builds against what
a host serves. The serving half is somebody else's deployment and cannot be
tested here. The BUILDING half can, and it is the half that fails silently: if
`repo_paths()` ever returned an empty set — an import that moved, a FastAPI
version that renamed `paths` — the script would report "no drift" against every
host on earth and look like good news.

That failure mode is the whole reason this file exists. A checker that cannot see
its own side is worse than no checker, because it answers.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

from verify_deploy_drift import _family, hosts, repo_paths  # noqa: E402


def test_the_repo_side_is_not_empty() -> None:
    """An empty set would make every host look perfectly in sync."""
    built = repo_paths()
    assert len(built) > 30, (
        f"repo_paths() sees only {len(built)} routes; the app has substantially more, "
        "so the comparison would report no drift no matter what a host served"
    )


def test_the_repo_side_sees_the_routes_the_product_depends_on() -> None:
    """Named explicitly, because these are the ones that were missing in
    production and whose absence rendered `/spend` and `/traction` empty. If the
    repo stops building them this test fails here rather than leaving a reviewer
    to find an empty page."""
    built = repo_paths()
    for path in (
        "/operator/traction",
        "/operator/statement/{business}",
        "/par",
        "/health",
        "/tca/{payer}",
    ):
        assert path in built, f"{path} is not in app.openapi() — the product lost a route"


def test_every_built_path_is_rooted() -> None:
    """A relative path would never match a served one, so it would read as drift
    forever — a permanent false positive is how a check gets muted."""
    for p in repo_paths():
        assert p.startswith("/"), f"{p!r} is not rooted"


def test_families_group_by_first_segment() -> None:
    """The report groups by feature so a missing `/operator/*` reads as one line
    rather than five paths a reader has to pattern-match."""
    got = _family({"/operator/traction", "/operator/ledger/{b}", "/par", "/health"})
    assert got == {"operator": 2, "par": 1, "health": 1}


def test_hosts_are_rstripped_so_a_trailing_slash_cannot_double_up() -> None:
    """`f"{base}/openapi.json"` against a base ending in `/` requests
    `//openapi.json`, which some proxies answer with a redirect and others with a
    404 — and a 404 here is indistinguishable from a host that serves nothing."""
    import os

    before = os.environ.get("VERIFY_DRIFT_HOSTS")
    os.environ["VERIFY_DRIFT_HOSTS"] = "https://example.invalid/,https://other.invalid"
    try:
        assert hosts() == ("https://example.invalid", "https://other.invalid")
    finally:
        if before is None:
            os.environ.pop("VERIFY_DRIFT_HOSTS", None)
        else:
            os.environ["VERIFY_DRIFT_HOSTS"] = before
