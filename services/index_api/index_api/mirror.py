"""Deciding what to mirror — the policy layer over ``MirrorClient``.

The client knows how to write a settlement on chain. This knows which ones may
be written, and it is deliberately strict, because everything it lets through
becomes a row in a public benchmark that cannot be edited afterwards.

Four gates, each closing a way the tape could end up saying something untrue:

* **Real settlements only.** Dev and sim receipts never touch the chain — the
  same ``_REAL_SCHEMES`` rule the durable ledger already applies. Invented
  revenue on a public counter is bad; invented settlements in a benchmark are
  worse.
* **Priced settlements only.** A receipt with no seller or no quantity has no
  unit price, and a settlement with no unit price contributes nothing to
  transaction-cost analysis but still lands in the volume a rating divides by.
* **Fresh settlements only.** ``ReceiptMirror`` bounds the ordinary path at one
  hour. Anything older is *reported*, not silently dropped and not quietly
  pushed through the owner-only late path — an operator decides that.
* **Bounded work per tick.** The keeper's first rule is that it can never take
  the press down.
"""

from __future__ import annotations

import logging
import time

from acr_oracle_client import MirrorClient

from .fleet import listing_for_resource
from .x402 import _REAL_SCHEMES, PaymentReceipt

log = logging.getLogger("index_api.mirror")

#: Matches ``ReceiptMirror.MAX_MIRROR_LAG``. Kept as its own constant rather
#: than read from chain: a keeper that discovered the bound by reverting has
#: already spent the gas.
MAX_MIRROR_LAG_S = 3600

#: Settlements mirrored per tick. Two transactions each, so this bounds the
#: keeper's chain time — a backlog drains over several ticks rather than
#: stalling one.
BATCH = 8


def mirrorable(r: PaymentReceipt, now: float | None = None) -> tuple[bool, str]:
    """Whether this receipt may be mirrored, and why not when it may not."""
    now = time.time() if now is None else now
    if r.scheme not in _REAL_SCHEMES:
        return False, "not a real settlement"
    if not r.seller:
        return False, "no seller — a platform-flat receipt has no unit price"
    if r.quantity <= 0:
        return False, "no quantity — nothing to divide the amount by"
    if r.amount_usdc <= 0:
        return False, "no amount"
    if not r.settled_at:
        return False, "no settlement time — nothing to anchor arrival to"
    if r.settled_at > now:
        return False, "settled in the future"
    if now - r.settled_at > MAX_MIRROR_LAG_S:
        return False, "older than the mirror window — needs the operator's late path"
    return True, ""


def mirror_once(
    receipts: list[PaymentReceipt],
    client: MirrorClient | None = None,
    now: float | None = None,
    dry_run: bool = False,
) -> str | None:
    """Mirror what is eligible. Returns a verdict string, or None when idle.

    Never raises: this runs as a keeper chore, and a chore that throws costs the
    press a beat. A per-settlement failure is counted and reported, and the next
    tick tries again — the contract's own replay guards make that safe.
    """
    client = client or MirrorClient()
    if not client.configured():
        return None

    eligible = [r for r in receipts if mirrorable(r, now)[0]]
    if not eligible:
        return None

    opened = finalized = skipped = failed = 0
    stale = sum(
        1
        for r in receipts
        if r.scheme in _REAL_SCHEMES
        and r.seller
        and mirrorable(r, now)[1].startswith("older than")
    )

    for r in eligible[:BATCH]:
        listing = listing_for_resource(r.resource)
        if listing is None:
            skipped += 1
            continue
        try:
            state = client.state_for(r.tx_ref)
            if state is None:
                client.open_settlement(
                    tx_ref=r.tx_ref,
                    payer=r.payer,
                    seller=r.seller,
                    index_id=listing.index_id,
                    amount_usdc=r.amount_usdc,
                    settled_at=r.settled_at,
                    synthetic=True,
                    dry_run=dry_run,
                )
                opened += 1
                state = {"opened": True, "finalized": False}
            if not state.get("finalized"):
                client.finalize_settlement(
                    tx_ref=r.tx_ref,
                    service=listing.service,
                    quantity=r.quantity,
                    dry_run=dry_run,
                )
                finalized += 1
        except Exception as exc:  # noqa: BLE001 — the reason matters, not the trace
            failed += 1
            log.warning("mirror %s failed: %s", r.tx_ref[:12], str(exc)[:160])

    # `skipped` counts too: a receipt that passed every gate and still could not
    # be placed against an index is a hole in the tape for a reason nobody has
    # named yet, which is precisely the case worth surfacing.
    if not (opened or finalized or failed or skipped or stale):
        return None
    parts = []
    if opened:
        parts.append(f"opened {opened}")
    if finalized:
        parts.append(f"finalized {finalized}")
    if failed:
        parts.append(f"FAILED {failed}")
    if skipped:
        parts.append(f"skipped {skipped} (no listing)")
    if stale:
        # Surfaced, never silently dropped: an unmirrored settlement is a hole in
        # a public tape, and a hole nobody is told about reads as an absence of
        # trading rather than an absence of mirroring.
        parts.append(f"{stale} past the mirror window — operator late-path needed")
    return " · ".join(parts)
