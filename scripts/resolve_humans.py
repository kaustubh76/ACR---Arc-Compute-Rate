#!/usr/bin/env python
"""Record which wallets act for which verified human, so the tape can count them.

The manipulation bound ACR publishes is denominated in wallets, and a wallet
costs a funding transfer. Denominating it in humans is the whole point of Module
W, and it needs one fact the chain does not otherwise have: which payer wallets
belong to one person. This writes that fact — as a WINDOW-ROTATED CLUSTER ID,
never a World ID nullifier. See `contracts/src/HumanIdMirror.sol` for why.

    ACR_HUMANID_MIRROR_ADDRESS=0x… uv run python scripts/resolve_humans.py --dry-run
    ACR_HUMANID_MIRROR_ADDRESS=0x… uv run python scripts/resolve_humans.py --commit

RUN THIS BEFORE GENERATING TAPE. `Settlement.human` is stamped at finalize and
the entity is immutable, so a payer that settles before it is resolved is counted
non-human forever and its volume never reaches `humanVolume`. The subgraph flags
it (`Payer.resolvedLate`) but cannot repair it.

Reads the AgentBook — the fixture roster until World Sandbox access exists, and
every fixture human is flagged `sandbox` all the way onto the chain so a rating
that counts them says how much of its human depth is demo. Needs a signer:
``ACR_POSTER_PRIVATE_KEY`` or the Circle poster wallet, the same wallet that
signs oracle prints. Needs ``ACR_HUMANID_SALT``, which must hash to the
commitment the mirror was deployed with — checked here, because a wrong salt
derives cluster ids that match nothing and every surface would then read "no
humans" while every transaction succeeded.

Exit codes: 0 = the tape is up to date (something was resolved, or everything
already was); 1 = it could not be brought up to date — no address, no signer, no
salt, a salt that disagrees with the chain, or an unreachable node. "Nothing to
resolve" is the normal steady state of a recurring chore, so it is a success.
"""

from __future__ import annotations

import argparse
import sys

from acr_core import get_settings
from acr_oracle_client.agentbook import build_agentbook
from acr_oracle_client.humanid import HumanIdMirrorClient, cluster_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="sign and self-check against the chain, but do not broadcast")
    ap.add_argument("--commit", action="store_true",
                    help="actually broadcast (the default is a dry run)")
    args = ap.parse_args()
    # Dry by default: this writes identity to a public chain, and the one thing
    # that cannot be undone there is having published.
    dry_run = not args.commit
    sys.stdout.reconfigure(line_buffering=True)

    s = get_settings()
    if not s.humanid_mirror_address:
        print("set ACR_HUMANID_MIRROR_ADDRESS to the deployed HumanIdMirror "
              "(make deploy-humanid)")
        return 1
    if not s.humanid_salt:
        print("set ACR_HUMANID_SALT — without it there is no cluster id to record")
        return 1

    client = HumanIdMirrorClient(settings=s)
    if client.signer is None:
        print("  ✗ no signer — set ACR_POSTER_PRIVATE_KEY or the Circle poster wallet")
        return 1

    window = client.chain_window()
    if window is None:
        print(f"  ✗ cannot reach {client.rpc_url} — resolving nobody")
        return 1

    matches = client.salt_matches(s.humanid_salt)
    if matches is False:
        print("  ✗ ACR_HUMANID_SALT does not hash to the mirror's SALT_COMMITMENT.")
        print("    Every cluster id derived from it would match nothing on the tape,")
        print("    and every surface would read 'no humans' while the writes succeeded.")
        return 1

    book = build_agentbook(s)
    humans = book.humans()
    print(f"  agentbook: {book.source}, {len(humans)} human(s), window {window}")

    wrote = skipped = 0
    for human in humans:
        cluster = cluster_id(human.nullifier, s.humanid_salt, window)
        tag = "sandbox" if human.sandbox else "orb-verified"
        print(f"\n  human ••••{human.nullifier[-3:]} · {tag} · {len(human.wallets)} wallet(s)")
        print(f"    cluster 0x{cluster.hex()}")
        for wallet in human.wallets:
            already = client.cluster_of(wallet, window)
            if already == cluster:
                print(f"    = {wallet}  already resolved")
                skipped += 1
                continue
            tx = client.record(wallet, cluster, window, human.sandbox, dry_run=dry_run)
            print(f"    + {wallet}  {tx or '(not broadcast)'}")
            wrote += 1

    if not humans:
        print("\n  ✓ nothing to resolve — the agentbook lists no humans")
        return 0
    print(f"\n  {wrote} to record, {skipped} already on chain")
    if dry_run:
        print("  dry run — signed and checked against the contract's own digest, "
              "nothing broadcast")
        print("  re-run with --commit to write. Do it BEFORE generating tape:")
        print("  Settlement.human is stamped at finalize and cannot be revised.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
