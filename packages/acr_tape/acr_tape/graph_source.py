"""``GraphSource`` — the indexed settlement tape, read from The Graph.

The only source that can support transaction-cost analysis. ``ArcSource`` scans
raw USDC transfers, which carry no service and no size. ``ReceiptSource`` reads
the facilitator's own ledger, which until the seller fleet existed was one payee
at one flat price — its docstring says so, and notes the estimator correctly
yields zero surviving observations on it. Neither carries a per-seller unit
price, and without one every payer's slippage against arrival is identically
zero.

The subgraph does carry it. ``Settlement.unitPrice`` is computed in the mapping
from an arrival snapshot the keeper committed before the quantity was known
(see ``graph/src/mirror.ts``), so the price this source reads was derived from
indexed chain data rather than handed over by the party being measured.

Enable with ``ACR_TAPE_SOURCE=graph`` (needs ``ACR_SUBGRAPH_URL``).

**Degrades, never raises.** Same discipline as ``ArcSource``: an unset URL, an
unreachable endpoint, a GraphQL error or a malformed row yields an empty tape
and a warning. The estimator then prints from whatever else it has rather than
the API returning a 500 — but note that empty is reported as empty, never as a
zero-priced settlement.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator

from acr_core import (
    INDEX_REGISTRY,
    SellerAttestation,
    Service,
    TapeEvent,
    get_settings,
)

from .base import TapeSource
from .graph_client import PAGE, SKIP_CEILING, graph_query

log = logging.getLogger("acr_tape.graph")

#: Prices and quantities are WAD 1e18 in the subgraph; USDC amounts are 1e6.
WAD = 10**18


_SETTLEMENTS_QUERY = """
query Settlements($first: Int!, $skip: Int!) {
  settlements(
    first: $first
    skip: $skip
    orderBy: settledAt
    orderDirection: asc
    where: { benchmarked: true }
  ) {
    id
    index
    payer { id }
    seller { id }
    amount
    quantity
    unitPrice
    slippageBp
    settledAt
    synthetic
  }
}
"""

_ATTESTATIONS_QUERY = """
query Attestations($first: Int!, $skip: Int!) {
  attestations(first: $first, skip: $skip, orderBy: timestamp, orderDirection: asc) {
    id
    seller { id }
    service
    modelClass
    latencySloMs
    schemaId
    timestamp
  }
}
"""


class GraphSource(TapeSource):
    def __init__(self, url: str | None = None, api_key: str | None = None) -> None:
        s = get_settings()
        # None → read from settings; "" → disabled (empty tape), which is what
        # every offline test and every unconfigured deployment gets.
        self.url = s.subgraph_url if url is None else url
        self.api_key = s.graph_api_key if api_key is None else api_key

    # --- transport ----------------------------------------------------------
    # Delegated to `graph_client`, so the API's TCA surfaces and this tape source
    # cannot drift into different timeouts or error conventions.

    def _query(self, query: str, variables: dict) -> dict:
        return graph_query(self.url, query, variables, self.api_key)

    def _paged(self, query: str, field: str) -> list[dict]:
        """Page through ``field`` via ``self._query``, not the module function.

        One override point: a test that swaps the transport must not have to
        swap the pagination too, or the two go out of step and the paging is
        never exercised against a recorded payload at all.
        """
        out: list[dict] = []
        skip = 0
        while True:
            rows = (self._query(query, {"first": PAGE, "skip": skip}) or {}).get(field) or []
            out.extend(rows)
            if len(rows) < PAGE:
                return out
            skip += PAGE
            if skip > SKIP_CEILING:
                log.warning("GraphSource: %s exceeded the pagination ceiling", field)
                return out

    # --- TapeSource ---------------------------------------------------------

    def stream(self) -> Iterator[TapeEvent]:
        rows = self._paged(_SETTLEMENTS_QUERY, "settlements")
        if not rows:
            log.info("GraphSource: no settlements; empty tape")
            return

        parsed: list[tuple[float, dict]] = []
        for r in rows:
            try:
                ts = float(r["settledAt"])
                quantity = int(r["quantity"]) / WAD
                unit_price = int(r["unitPrice"]) / WAD
            except (KeyError, TypeError, ValueError):
                continue  # skip a malformed row rather than fail the window
            if ts <= 0 or quantity <= 0 or unit_price <= 0:
                continue
            parsed.append((ts, r))
        if not parsed:
            return

        # Normalized to seconds from the first settlement: the store windows in
        # seconds from 0, so absolute epoch timestamps would misalign every
        # window. Same reason ArcSource interpolates and ReceiptSource subtracts.
        parsed.sort(key=lambda t: t[0])
        t0 = parsed[0][0]
        for ts, r in parsed:
            spec = INDEX_REGISTRY.get(str(r.get("index", "")))
            if spec is None:
                continue
            yield TapeEvent(
                event_id=str(r["id"]),
                ts=ts - t0,
                service=spec.service,
                seller=str(r["seller"]["id"]),
                buyer=str(r["payer"]["id"]),
                price=int(r["unitPrice"]) / WAD,
                size=int(r["quantity"]) / WAD,
                settled_ts=ts,
            )

    def attestations(self) -> list[SellerAttestation]:
        """Seller metadata as the subgraph indexed it.

        The same records ``ArcSource`` reads over 1 + 2N rate-limited RPC calls,
        in one query — which is most of why the subgraph is worth having even
        before TCA.
        """
        from acr_core import ModelClass
        from acr_oracle_client.registry import CODE_TO_CLASS, CODE_TO_SERVICE

        out: list[SellerAttestation] = []
        for r in self._paged(_ATTESTATIONS_QUERY, "attestations"):
            try:
                out.append(
                    SellerAttestation(
                        seller=str(r["seller"]["id"]),
                        service=CODE_TO_SERVICE.get(int(r["service"]), Service.INFERENCE),
                        # Same defaults as RegistryClient's on-chain decode, so
                        # the two paths cannot disagree about an unknown code.
                        model_class=CODE_TO_CLASS.get(int(r["modelClass"]), ModelClass.OPEN),
                        latency_slo_ms=float(r["latencySloMs"]),
                        schema_id=str(r.get("schemaId") or ""),
                        ts=float(r["timestamp"]),
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                log.debug("GraphSource: skipping undecodable attestation (%s)", exc)
        return out
