#!/usr/bin/env python
"""Create the venue's developer-controlled wallets in the EXISTING wallet set.

Why these are developer-controlled and not agent wallets: they are driven by
cron. `futures-lifecycle` rolls a series at :17 and `futures-heartbeat` trades
at :00, with nobody watching. A Circle **agent** wallet authenticates with an
email OTP and its session expires, so it cannot be what wakes up at 02:17 UTC —
that is a human-in-the-loop credential doing an unattended job. A
developer-controlled wallet authenticates with an API key plus an entity secret
and has no session at all. See docs/WALLETS.md for the full map.

Why account type EOA rather than SCA: the same reason the press wallet is an
EOA. It costs nothing here (the futures venue has no `ecrecover` on the trade
path) and it keeps every wallet in this set interchangeable with the poster, so
one of them can sign an EIP-712 print if the press wallet ever has to be
replaced. "Custodied" and "EOA" are orthogonal — Circle holds the key, the chain
sees an EOA.

Why TWO wallets: ``ACRFutures.trade`` reverts with "maker cannot take" when
``msg.sender == series.maker``, so the maker and the heartbeat taker have to be
different addresses. One wallet doing both jobs cannot trade its own book.

Idempotent: wallets are matched on their ``refId``, so a second run reports what
already exists rather than minting duplicates that would silently split the
venue's collateral across addresses nobody is watching.

    uv run python scripts/create_venue_wallets.py            # == make venue-wallets
    VENUE_WALLETS_DRY_RUN=1 …                                # show, create nothing

Prints the ids to add to `.env` / the Render dashboard. Never prints a key —
there is no key to print, which is the entire point.
"""

from __future__ import annotations

import os
import sys

from acr_core import get_settings

BLOCKCHAIN = "ARC-TESTNET"
DRY_RUN = os.environ.get("VENUE_WALLETS_DRY_RUN", "") not in ("", "0", "false")

#: (refId, human name, the env var its id belongs in, what it does)
ROLES = [
    ("acr-venue-maker", "ACR Venue Maker", "ACR_CIRCLE_MAKER_WALLET_ID",
     "the book's counterparty; every desk fill mirrors onto it"),
    ("acr-venue-taker", "ACR Venue Taker", "ACR_CIRCLE_TAKER_WALLET_ID",
     "the hourly heartbeat that keeps the tape moving"),
]


def _dig(obj, *path):
    cur = obj
    for p in path:
        nxt = getattr(cur, p, None)
        if nxt is None:
            dump = obj.to_dict() if hasattr(obj, "to_dict") else repr(obj)
            raise AttributeError(f"unexpected response shape at '{p}': {dump}")
        cur = nxt
    return cur


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    s = get_settings()
    api_key = (s.circle_api_key or "").strip()
    secret = (s.circle_entity_secret or "").strip()
    wallet_set = (s.circle_wallet_set_id or "").strip()

    # A '#'-leading value is a .env comment parsed as a value — the failure this
    # config layer has hit before. Treat it as absent rather than as credentials.
    bad = [
        n for n, v in (("ACR_CIRCLE_API_KEY", api_key),
                       ("ACR_CIRCLE_ENTITY_SECRET", secret),
                       ("ACR_CIRCLE_WALLET_SET_ID", wallet_set))
        if not v or v.startswith("#")
    ]
    if bad:
        print(f"  ✗ missing/placeholder: {', '.join(bad)}")
        sys.exit(1)

    from circle.web3 import developer_controlled_wallets as dcw
    from circle.web3 import utils

    client = utils.init_developer_controlled_wallets_client(
        api_key=api_key, entity_secret=secret
    )
    wallets_api = dcw.WalletsApi(client)

    existing = {}
    for w in _dig(wallets_api.get_wallets(wallet_set_id=wallet_set), "data", "wallets"):
        ref = getattr(w, "ref_id", None) or ""
        if ref:
            existing[ref] = w
    print(f"wallet set {wallet_set}\n  {len(existing)} wallet(s) already carry a refId\n")

    out: list[tuple[str, str, str]] = []
    for ref, name, env_var, purpose in ROLES:
        hit = existing.get(ref)
        if hit is not None:
            print(f"  ↩ {name} already exists — {getattr(hit, 'address', '?')}")
            out.append((env_var, str(getattr(hit, "id", "")), str(getattr(hit, "address", ""))))
            continue
        if DRY_RUN:
            print(f"  + would create {name} ({ref}) — {purpose}")
            continue
        resp = wallets_api.create_wallet(
            dcw.CreateWalletRequest(
                wallet_set_id=wallet_set,
                blockchains=[BLOCKCHAIN],
                count=1,
                account_type="EOA",
                metadata=[dcw.WalletMetadata(name=name, ref_id=ref)],
                entity_secret_ciphertext=utils.generate_entity_secret_ciphertext(
                    api_key, secret
                ),
            )
        )
        w = _dig(resp, "data", "wallets")[0]
        print(f"  ✓ created {name} — {getattr(w, 'address', '?')}")
        out.append((env_var, str(getattr(w, "id", "")), str(getattr(w, "address", ""))))

    if DRY_RUN:
        print("\ndry run — nothing was created")
        sys.exit(0)

    print("\nAdd to .env AND the Render dashboard:")
    for env_var, wid, _addr in out:
        print(f"    {env_var}={wid}")
    print("\nAddresses (fund these; on Arc, USDC is the gas token):")
    for env_var, _wid, addr in out:
        print(f"    {env_var.replace('ACR_CIRCLE_', '').replace('_WALLET_ID', ''):8s} {addr}")


if __name__ == "__main__":
    main()
