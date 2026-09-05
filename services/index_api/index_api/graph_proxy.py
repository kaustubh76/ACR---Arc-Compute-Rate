"""The subgraph read proxy — one origin, one key, an allowlist.

The Studio API key is server-side because a key shipped to a browser is a key
anyone can spend the quota of. But a proxy that forwards arbitrary GraphQL is
just the key with extra steps: a caller could mint expensive nested queries
against our quota, or use the endpoint as an open relay to any subgraph.

So the proxy is an allowlist of named operations, not a query passthrough. The
consumer sends an operation name and variables; the query text lives here. That
also means the tape's public read surface is a stable, documented API rather
than whatever a client happened to type — which is what lets the mappings change
shape without breaking every reader.
"""

from __future__ import annotations

import logging

from acr_core import get_settings
from acr_tape import graph_query

log = logging.getLogger("index_api.graph_proxy")

#: Hard ceiling on any `first:` a caller asks for. The Graph allows 1000; a
#: reader that needs more should page, and a reader that asks for more than this
#: in one call is either confused or probing.
MAX_FIRST = 200

OPERATIONS: dict[str, str] = {
    "prints": """
      query Prints($index: String!, $first: Int!) {
        prints(where: { index: $index }, orderBy: postedAt, orderDirection: desc, first: $first) {
          id index value ciLo ciHi attackCostPerBp timestamp postedAt oracleVersion block
        }
      }
    """,
    "settlements": """
      query Settlements($first: Int!) {
        settlements(orderBy: settledAt, orderDirection: desc, first: $first) {
          id index payer { id } seller { id } amount quantity unitPrice
          benchmarked unbenchmarkedReason slippageBp arrivalValue arrivalAgeSeconds
          staleArrival synthetic settledAt mirrorLagSeconds
        }
      }
    """,
    "sellerDays": """
      query SellerDays($seller: Bytes!, $first: Int!) {
        sellerDays(where: { seller: $seller }, orderBy: day, orderDirection: desc, first: $first) {
          day volume bmVolume wSlipTenthBp synthVolume realVolume n nAll nStale
          b0 b1 b2 b3 b4 b5 b6
        }
      }
    """,
    "payerDays": """
      query PayerDays($payer: Bytes!, $first: Int!) {
        payerDays(where: { payer: $payer }, orderBy: day, orderDirection: desc, first: $first) {
          day spent bmSpent wSlipTenthBp overpay n nAll
        }
      }
    """,
    "sellers": """
      query Sellers($first: Int!) {
        sellers(orderBy: totalVolume, orderDirection: desc, first: $first) {
          id totalVolume benchmarkedVolume settlementCount distinctPayers distinctHumans
          latestAttestation { modelClass latencySloMs blockTime }
        }
      }
    """,
    "futuresFills": """
      query FuturesFills($first: Int!) {
        fills: futuresFills(orderBy: blockTime, orderDirection: desc, first: $first) {
          id index taker qty mark benchmarked slippageBp blockTime
          series { id expiryTs settled settlementPrice }
        }
      }
    """,
    "economicPrints": """
      query EconomicPrints($index: String!, $first: Int!) {
        economicPrints(where: { index: $index }, orderBy: timestamp, orderDirection: desc, first: $first) {
          id index timestamp postedAt value ciLo ciHi attackCostPerBp
          humanAdjustedBound policyHash windowStart windowEnd oracleMask divergent
        }
      }
    """,
    "collateralFlows": """
      query CollateralFlows($first: Int!) {
        collateralFlows(orderBy: blockTime, orderDirection: desc, first: $first) {
          id trader amount deposited blockTime series { id index }
        }
      }
    """,
    "signerChanges": """
      query SignerChanges($first: Int!) {
        signerChanges(orderBy: blockTime, orderDirection: desc, first: $first) {
          id contract contractName signer allowed blockTime
        }
      }
    """,
    "pauseChanges": """
      query PauseChanges($first: Int!) {
        pauseChanges(orderBy: blockTime, orderDirection: desc, first: $first) {
          id contract contractName paused blockTime
        }
      }
    """,
    "pendingSettlements": """
      query PendingSettlements($first: Int!) {
        pendingSettlements(where: { finalized: false }, orderBy: blockTime, orderDirection: desc, first: $first) {
          id payer seller index amount settledAt mirrorLagSeconds late
          benchmarked unbenchmarkedReason arrivalValue arrivalAgeSeconds
        }
      }
    """,
    "meta": """
      query Meta {
        _meta { block { number timestamp } hasIndexingErrors deployment }
      }
    """,
}


def run(operation: str, variables: dict | None = None) -> dict:
    """Execute an allowlisted operation. Never forwards caller-supplied text."""
    # The caller's mistake is reported before ours: an unknown operation is
    # always an unknown operation, and masking it behind a server-config message
    # sends the reader looking in the wrong place.
    query = OPERATIONS.get(operation)
    if query is None:
        return {
            "available": False,
            "reason": f"unknown operation {operation!r}",
            "operations": sorted(OPERATIONS),
        }
    s = get_settings()
    if not s.subgraph_url:
        return {"available": False, "reason": "ACR_SUBGRAPH_URL is unset"}

    args = dict(variables or {})
    # Clamp rather than reject: a caller asking for too much gets the most we
    # will serve, and is told so, instead of an error they have to guess at.
    requested = int(args.get("first", 100) or 100)
    args["first"] = max(1, min(MAX_FIRST, requested))
    # Addresses are indexed lower-cased by the mappings; a caller pasting a
    # checksummed address would otherwise get a silent empty result.
    for key in ("seller", "payer"):
        if key in args and isinstance(args[key], str):
            args[key] = args[key].lower()

    data = graph_query(s.subgraph_url, query, args, s.graph_api_key)
    if not data:
        return {"available": False, "reason": "the subgraph did not answer"}
    return {
        "available": True,
        "operation": operation,
        "variables": args,
        "clamped": requested != args["first"],
        "data": data,
    }
