"""The GraphQL transport — one place, so nothing can drift.

Both the estimator's tape source and the API's TCA surfaces read the same
subgraph. Two transports would eventually differ in a timeout, an auth header or
an error convention, and the symptom would be two ACR surfaces disagreeing about
the same public data — which is the one thing a benchmark cannot afford.

``urllib`` rather than httpx deliberately: nothing else in ``packages/`` carries
an HTTP dependency, and a tape adapter is not the place to add one to the
estimator's install.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

log = logging.getLogger("acr_tape.graph")

#: The Graph caps `first` at 1000 and refuses `skip` past 5000 on one query.
PAGE = 1000
SKIP_CEILING = 5000


def graph_query(
    url: str, query: str, variables: dict, api_key: str = "", timeout: float = 20.0
) -> dict:
    """One GraphQL POST. Returns ``{}`` on any failure — never raises.

    A GraphQL endpoint answers 200 with an ``errors`` array, so a malformed
    query looks exactly like a good one to the transport layer. Both are treated
    as no data, and both are logged: an empty tape reported as empty is honest,
    an empty tape reported as zero is not.
    """
    if not url:
        return {}
    body = json.dumps({"query": query, "variables": variables}).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "acr-graph"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            payload = json.loads(r.read() or b"{}")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        log.warning("graph: query failed (%s)", exc)
        return {}
    if payload.get("errors"):
        log.warning("graph: GraphQL errors: %s", payload["errors"][:2])
        return {}
    return payload.get("data") or {}


def graph_paged(url: str, query: str, field: str, api_key: str = "") -> list[dict]:
    """Walk every page of ``field``. Stops at the endpoint's skip ceiling.

    A window large enough to hit the ceiling is the caller's to narrow — better
    an explicit warning than a silently truncated tape that reads as a quiet
    market.
    """
    out: list[dict] = []
    skip = 0
    while True:
        data = graph_query(url, query, {"first": PAGE, "skip": skip}, api_key)
        rows = data.get(field) or []
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        skip += PAGE
        if skip > SKIP_CEILING:
            log.warning("graph: %s exceeded the pagination ceiling; tape truncated", field)
            return out
