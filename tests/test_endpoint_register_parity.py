"""Every route the service exposes is named somewhere a reader can find it.

THE ONE GUARD THIS REPO DID NOT HAVE, and the gap is specific. Both existing
drift guards are one-directional:

  * `services/index_api/tests/test_marketplace.py` binds only the PAID endpoint
    set (`ENDPOINT_FAMILIES` against `GATED_ENDPOINTS`),
  * `apps/terminal/lib/chain.test.ts` checks that paths ALREADY IN
    `endpoints.ts` have prose in `developers/view.tsx`.

So a route added to `app.py` and nowhere else is invisible to an otherwise dense
network of checks — which is exactly how `/agent/info`, `/agent/challenge` and
`/armor/info` shipped without appearing on `/developers`, and how `/hedger` has
been missing from the register since it was written.

Python reads the TypeScript rather than the other way round because only Python
can call `app.openapi()`. A committed `openapi.json` would be a second source of
truth that goes stale silently, which is the failure both `endpoints.ts` and
`test_human_window_parity.py` exist to prevent. The repo already crosses the
language line in both directions: `test_human_window_parity.py` reads
`graph/src/parties.ts`, and `chain.test.ts` reads `index_api/ops.py`.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTER = ROOT / "apps" / "terminal" / "lib" / "endpoints.ts"

_ROW = re.compile(r'path:\s*"([^"]+)"')

#: Routes deliberately absent from the reader-facing register, each with the
#: reason it is absent. A DICT RATHER THAN A SET because an exemption with no
#: reason is an exemption nobody ever has to defend, and this list is precisely
#: where a route would go to disappear quietly.
NOT_IN_THE_REGISTER: dict[str, str] = {
    "/ops/verify": (
        "an operator surface. NOT token-gated — `app.py` says 'Ungated and "
        "read-only' and the terminal proxies it to the public /ops page with no "
        "token; only /ops/actions carries X-ACR-Ops-Token. The reason it is off "
        "/developers is audience, not access: that page is a developer's index "
        "of what a machine can buy, and the operator's own console already "
        "surfaces this one"
    ),
    "/ops/actions": "same, and with dry_run=False it spends real money",
    # The guest join pair. Off /developers for the same reason /ops/verify is:
    # audience, not access. That page is a developer's index of what a MACHINE
    # can buy, and these two are steps a PERSON walks in a browser -- a nonce
    # bound to their wallet, then a World ID proof spent for a small budget.
    # Nothing a machine can call usefully: /bind hands back rows that are
    # unspendable without a widget our signing key signed, and /claim needs a
    # proof only World can mint. The join page itself is where a reader finds
    # them.
    "/float/guest/bind": (
        "a browser step on the public join page, not something a machine buys: it "
        "ties a join request to one wallet, and the nonce it binds is unspendable "
        "unless our signing key signed it into the widget's rp_context"
    ),
    "/float/guest/claim": (
        "the other half of that browser step: it spends a join request for one "
        "guest budget against a World ID proof, and uniqueness is enforced on "
        "chain rather than here"
    ),
    "/compute/{label}": (
        "a fleet seller's metered endpoint, reached by a buyer agent through "
        "/marketplace/catalog and never typed by a reader; it IS in GATED_ENDPOINTS, "
        "so /x402/info names it paid"
    ),
    # The owner payment inbox (#66). Bearer-token routes (ACR_TREASURY_API_TOKEN,
    # 401 until it is set) that the owner's own treasury App calls; they stage a
    # payment the owner signs in their wallet. Owner tooling, not something a
    # developer's machine buys, so they are off /developers like /ops/*.
    "/operator/payments": "owner payment inbox, token-gated: lists bills awaiting the owner",
    "/operator/payments/prepare": (
        "owner payment inbox, token-gated: returns unsigned calldata the owner signs; the server never signs"
    ),
    "/operator/payments/verify": "owner payment inbox, token-gated: reconciles a payment the owner sent",
    # The World gate's two reads. Parking a payment is not a route at all — it
    # is `float/checkpoint` in ops_actions.ACTIONS, reached through
    # /ops/actions like every other thing that spends money. These two are the
    # public view of what is parked, and they are off /developers for the same
    # reason /ops/verify is: that page is a developer's index of what a MACHINE
    # can buy, and an owner's approval queue is not something a machine buys.
    # Audience, not access.
    "/float/checkpoints": (
        "the World gate's approval queue, ungated and read-only. Owner tooling: the terminal "
        "proxies it to the approvals card exactly as it proxies /ops/verify, and a reader's "
        "machine has nothing to buy here"
    ),
    "/float/checkpoint/{cp_id}": (
        "the same public view for one parked payment, so an agent that was told `needs_human` "
        "can poll its own checkpoint without ever seeing a device code or a token"
    ),
}


def _register_paths() -> set[str]:
    paths = set(_ROW.findall(REGISTER.read_text(encoding="utf-8")))
    # A regex that silently matched nothing would make every assertion below pass
    # vacuously — the failure shape this whole file is about.
    assert len(paths) > 20, f"only {len(paths)} rows parsed from endpoints.ts — has the shape changed?"
    return paths


def _openapi_paths() -> set[str]:
    from index_api.app import app

    # FastAPI keys these by the literal decorator string, and the register writes
    # `{index_id}` / `{payer}` / `{seller}` identically, so no normalisation is
    # needed. /docs, /redoc and /openapi.json are include_in_schema=False.
    return set(app.openapi()["paths"])


def test_every_route_is_either_in_the_register_or_excused():
    """A new route must be named on /developers or excused here, by name, with a
    reason. Nothing else is allowed to be true."""
    missing = sorted(_openapi_paths() - _register_paths() - set(NOT_IN_THE_REGISTER))
    assert missing == [], (
        "these routes exist but no reader can find them — add a row to "
        f"apps/terminal/lib/endpoints.ts (and an <Ed> in developers/view.tsx), or "
        f"excuse them in NOT_IN_THE_REGISTER with a reason: {missing}"
    )


def test_every_exemption_still_names_a_real_route():
    """An exemption that outlives its route turns this list into fiction, and a
    fictional exemption list is worse than none: it reads as though somebody
    checked."""
    stale = sorted(set(NOT_IN_THE_REGISTER) - _openapi_paths())
    assert stale == [], f"excused routes that no longer exist: {stale}"


def test_the_register_does_not_name_routes_that_are_gone():
    """The drift in the other direction — the register advertising a route the
    service no longer serves. This is literally what happened between the footer
    and /developers over which contracts exist, per endpoints.ts's own header."""
    phantom = sorted(_register_paths() - _openapi_paths())
    assert phantom == [], f"endpoints.ts names routes the API does not serve: {phantom}"
