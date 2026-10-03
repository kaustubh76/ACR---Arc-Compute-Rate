#!/usr/bin/env python3
"""Run the spend operator for one registered business.

    uv run python scripts/operator_run.py --business acr-fleet
    uv run python scripts/operator_run.py --business acr-fleet --live   # pays

WHAT AN OBLIGATION IS HERE, and why it is not invented. The fleet's own
settlement archive says which machine services it consumed and how much of each.
The marketplace catalog says what each seller is asking for those same services
right now. One obligation per (seller, resource) the fleet actually bought from:
*this seller wants this price for a service we really consume, and we have our
own count of how much we took*. Nothing is synthesised — the vendor, the
resource, the quantity and the price all come from records that existed before
this script ran.

DRY RUN IS THE DEFAULT, and with no PolicyWallet configured it is the only mode:
the operator prices and meters and writes down what it would do. `--live` is
refused unless the business has a wallet, because a "live" run that silently
could not pay would be a dry run wearing the wrong label.

The decisions this writes are what `/spend` reads. They are also the honest
Tameion delta for this business: its settlements predate the window, every
decision here does not.
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict

from acr_core import get_settings
from index_api.businesses import resolve
from index_api.marketplace import build_catalog
from index_api.operator import (
    ESCALATE,
    PAY,
    Obligation,
    obligation_key,
    resource_path,
    run_obligation,
    settled_refs_from,
)


def _receipts(settings) -> list[dict]:
    """The business's own settlement history, as the seller archives it."""
    import json
    from pathlib import Path

    here = Path(__file__).resolve().parents[1]
    path = here / "services/index_api/index_api/receipts_live.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def _rpc_host(url: str) -> str:
    """The endpoint's host, never its path.

    `https://rpc.testnet.arc-node.thecanteenapp.com/v1/<key>` identifies us by a
    secret in its path, so the only safe thing to print is the hostname.
    """
    from urllib.parse import urlparse

    try:
        return urlparse(url or "").hostname or "(none)"
    except ValueError:
        return "(unparseable)"


def _path_of(resource: str) -> str:
    """Kept as a name this file already uses; the rule lives in `operator`."""
    return resource_path(resource)


def _obligations(business, receipts: list[dict], catalog: dict) -> list[Obligation]:
    """One per (seller, resource) this business really bought, for the period.

    AN OBLIGATION HERE IS A PERIOD'S BILL, not a single call, and that is a unit
    decision rather than a presentational one. The benchmark is a UNIT price
    ($/1k tokens), so the thing compared against it has to be a unit price too.
    Pairing one call's price with the meter's cumulative count divides a
    per-call figure by a period's quantity and reports nine thousand basis
    points of discount — which is precisely what the first version of this
    script did, on real data, before anybody looked.

    So: `billed_usdc` is everything that seller charged for that service, and
    `vendor_quantity` is everything we took. Their ratio is the effective unit
    price, which is the number the market can actually be compared with.
    """
    treasury = business.treasury.lower()
    billed: dict[tuple[str, str], float] = defaultdict(float)
    consumed: dict[tuple[str, str], float] = defaultdict(float)
    units: dict[tuple[str, str], str] = {}
    calls: dict[tuple[str, str], int] = defaultdict(int)

    for r in receipts:
        if (r.get("payer") or "").lower() != treasury:
            continue
        seller, resource = r.get("seller") or "", _path_of(r.get("resource") or "")
        amount, qty = r.get("amount_usdc"), r.get("quantity")
        if not seller or not resource or not isinstance(amount, (int, float)):
            continue
        key = (seller, resource)
        billed[key] += float(amount)
        consumed[key] += float(qty or 0.0)
        calls[key] += 1
        if r.get("unit"):
            units[key] = str(r["unit"])

    out: list[Obligation] = []
    for key in sorted(billed):
        seller, resource = key
        amount = billed[key]
        if amount <= 0:
            continue
        out.append(
            Obligation(
                obligation_id=obligation_key(business.slug, seller, resource),
                vendor=seller,
                # ROUNDED HERE, AND NOWHERE LATER. These are sums of x402
                # nanopayments — 0.004409607843137255 is a real receipt amount —
                # so a period's total is routinely finer than the six decimals
                # USDC actually has. `usdc_units` refuses such a number on the
                # way to the chain, and it is right to: "round it before paying,
                # so the rounding is a decision someone made."
                #
                # The decision is made HERE rather than at payment because
                # `billed_usdc` is what the ledger prints, what the chain
                # commits, and what `ledger_audit` compares `paid_usdc` against.
                # Rounding later would make every payment disagree with its own
                # bill by a fraction of a cent, and the audit would report an
                # error of original entry on every row — correctly.
                billed_usdc=round(amount, 6),
                business=business.slug,
                category=(business.categories or ("general",))[0],
                kind="x402",
                resource=resource,
                vendor_quantity=consumed[key] or None,
                # The unit is what makes two sellers comparable at all.
                unit=units.get(key, ""),
            )
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--business", required=True, help="registry slug or treasury address")
    ap.add_argument("--live", action="store_true", help="actually pay what clears policy")
    ap.add_argument("--limit", type=int, default=0, help="stop after N obligations")
    args = ap.parse_args()

    s = get_settings()
    b = resolve(args.business)
    if b is None:
        print(f"no business registered as {args.business!r}", file=sys.stderr)
        return 2

    policy = None
    if b.policy_wallet:
        from acr_oracle_client.policy import PolicyClient

        policy = PolicyClient(wallet_address=b.policy_wallet)
    elif args.live:
        print(
            f"{b.slug} has no PolicyWallet, so --live could not pay anything. "
            "Refusing rather than running a dry run under the wrong name.",
            file=sys.stderr,
        )
        return 2

    receipts = _receipts(s)
    catalog = build_catalog(s.x402_resource_base or "http://127.0.0.1:8000", s)
    obligations = _obligations(b, receipts, catalog)

    # What has already been paid, so check 1 has something to check against. It
    # never did: `decide` has taken `settled_refs` since it was written and this
    # script, its only real caller, never passed one — so a retried bill was
    # paid twice and the log would have shown two clean payments.
    from index_api.statement import read_decisions

    already = settled_refs_from(read_decisions(business=b.slug))
    if args.limit:
        obligations = obligations[: args.limit]

    # WHICH ENDPOINT THIS RAN THROUGH. Nothing in this repo recorded that, and on
    # testnet it decides whether the work counts at all: Canteen counts traction
    # through the RPC they issue, so a run against the public endpoint is work
    # that happened and was not seen. The HOST only — the Canteen URL carries a
    # key in its path, and a key printed to a terminal is a key in a transcript.
    print(f"rpc        : {_rpc_host(s.arc_rpc_url)}")
    print(f"business   : {b.slug} ({b.public_name}) on {b.chain}")
    print(f"receipts   : {len(receipts)} in the archive")
    print(f"settled    : {len(already)} reference(s) already paid")
    print(f"obligations: {len(obligations)}")
    print(f"mode       : {'LIVE' if args.live else 'dry run'}\n")

    tally: dict[str, int] = defaultdict(int)
    for ob in obligations:
        d = run_obligation(
            ob,
            receipts=receipts,
            catalog=catalog,
            policy=policy,
            settled_refs=already,
            dry_run=not args.live,
        )
        # Within one run too: two obligations resolving to one reference is the
        # retry shape, and the second must not be paid because the first just
        # was. Only a real payment joins the set, for the same reason
        # `settled_refs_from` ignores dry runs.
        if d.intent == PAY and d.paid_usdc > 0:
            already.add(ob.obligation_id)
            if ob.invoice_ref:
                already.add(ob.invoice_ref)
        tally[d.intent] += 1
        mark = {PAY: "pay", ESCALATE: "ask", "reroute": "reroute",
                "hold": "hold", "refuse": "refuse"}.get(d.intent, d.intent)
        name = ob.resource.rsplit("/", 1)[-1]
        print(f"  [{mark:>7}] {d.billed_usdc:>10.6f} {name:<24} {d.rule}")

    print("\n" + " · ".join(f"{k} {v}" for k, v in sorted(tally.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
