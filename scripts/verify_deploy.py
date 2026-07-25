#!/usr/bin/env python
"""Verify the Arc-testnet deploy — the read-only preflight for the live loop.

Loads settings from ``.env`` (``acr_core.get_settings``), connects to the Arc
RPC, and checks — with friendly ✓/✗ output and **no writes**:

  * the RPC's chain id matches ``ACR_ARC_CHAIN_ID``,
  * bytecode exists at ``ACR_ORACLE_ADDRESS`` and ``ACR_REGISTRY_ADDRESS``,
  * the poster signer ``isSigner()`` on the oracle — the raw
    ``ACR_POSTER_PRIVATE_KEY`` EOA, or (key blank) the Circle custody wallet,
  * ``latestPrint`` reads back per index (tolerating "no print" — a fresh
    deploy has none until ``make post-once``).

Prints arcscan URLs for both contracts and (best-effort) the most recent
``PricePosted`` tx. Exit codes: 0 = everything verified; 1 = a check failed —
including "no oracle configured", because an unconfigured ``.env`` means the
deploy hasn't happened yet, so a preflight gate must not pass.

    uv run python scripts/verify_deploy.py        # or: make verify-testnet
"""

from __future__ import annotations

import os
import sys

from acr_core import ALL_INDEX_IDS, get_settings
from acr_oracle_client.client import ORACLE_ABI, WAD, index_id_to_bytes32

FALLBACK_EXPLORER = "https://testnet.arcscan.app"

# `isSigner(address)` isn't part of the client's post/read ABI — add it here.
IS_SIGNER_ABI = {
    "type": "function",
    "name": "isSigner",
    "stateMutability": "view",
    "inputs": [{"name": "", "type": "address"}],
    "outputs": [{"name": "", "type": "bool"}],
}
PRICE_POSTED_SIG = "PricePosted(bytes32,uint256,uint256,uint256,uint256,uint64,address)"


def _explorer(settings) -> str:
    """ACR_EXPLORER_BASE (settings field or raw env) with the arcscan fallback."""
    base = getattr(settings, "explorer_base", "") or os.environ.get("ACR_EXPLORER_BASE", "")
    return (base or FALLBACK_EXPLORER).rstrip("/")


def _check(ok: bool, label: str) -> bool:
    print(f"  {'✓' if ok else '✗'} {label}")
    return ok


def _resolve_signer_address(settings) -> tuple[str | None, str]:
    """The address that will actually sign prints — custody-aware.

    A raw ``ACR_POSTER_PRIVATE_KEY`` signs as its own EOA (the default). With the
    key blank, prints are signed by the Circle developer-controlled wallet, whose
    on-chain address is a live Circle lookup via ``build_signer(...).address``.
    Returns ``(checksummed_address | None, label)`` — mirroring the same signer
    selection the poster uses, so the preflight checks the address that will post.
    """
    key = settings.poster_private_key or ""
    if key and not key.lstrip().startswith("#"):
        from eth_account import Account

        return Account.from_key(key).address, "poster (raw key)"
    # Circle custody path — never fails the whole preflight on a lookup hiccup.
    try:
        from acr_oracle_client import build_signer

        signer = build_signer(settings)
        if signer is not None:
            return signer.address, "poster (Circle custody)"
    except Exception as exc:  # pragma: no cover - needs live Circle creds
        print(f"  (Circle signer address lookup failed: {exc})")
    return None, ""


def main() -> None:
    s = get_settings()
    if not s.oracle_address:
        print(
            "\n  no oracle configured — set ACR_ORACLE_ADDRESS in .env; "
            "run the deploy first (make deploy-testnet).\n"
        )
        sys.exit(1)

    try:
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(s.arc_rpc_url, request_kwargs={"timeout": 10}))
        if not w3.is_connected():
            raise ConnectionError
    except Exception:
        print(f"\n  ✗ RPC unreachable at {s.arc_rpc_url} — check ACR_ARC_RPC_URL.\n")
        sys.exit(1)

    explorer = _explorer(s)
    print(f"\n  verifying the ACR deploy via {s.arc_rpc_url}\n")
    ok = True

    # ① chain id
    chain_id = w3.eth.chain_id
    ok &= _check(
        chain_id == s.arc_chain_id,
        f"chain id {chain_id} matches ACR_ARC_CHAIN_ID {s.arc_chain_id}",
    )

    # ② bytecode at both addresses
    oracle = Web3.to_checksum_address(s.oracle_address)
    ok &= _check(len(w3.eth.get_code(oracle)) > 0, f"bytecode at oracle    {oracle}")
    registry = None
    if s.registry_address:
        registry = Web3.to_checksum_address(s.registry_address)
        ok &= _check(len(w3.eth.get_code(registry)) > 0, f"bytecode at registry  {registry}")
    else:
        ok &= _check(False, "ACR_REGISTRY_ADDRESS not set in .env")

    # ③ the poster signer is an authorized oracle signer (raw key OR Circle custody)
    contract = w3.eth.contract(address=oracle, abi=[*ORACLE_ABI, IS_SIGNER_ABI])
    signer_addr, signer_label = _resolve_signer_address(s)
    if signer_addr:
        signer_addr = Web3.to_checksum_address(signer_addr)
        try:
            allowed = bool(contract.functions.isSigner(signer_addr).call())
        except Exception:
            allowed = False
        hint = "" if allowed else "  (cast send setSigner — docs/TESTNET_RUNBOOK.md step 3)"
        ok &= _check(allowed, f"{signer_label} {signer_addr} isSigner() on the oracle{hint}")
    else:
        ok &= _check(
            False,
            "no poster signer configured — set ACR_POSTER_PRIVATE_KEY, or Circle "
            "custody creds (ACR_CIRCLE_API_KEY + ACR_CIRCLE_WALLET_ID)",
        )

    # ④ latest print per index — "no print yet" is expected on a fresh deploy
    print(f"\n  {'INDEX':<9} {'on-chain latest':>16}")
    print("  " + "-" * 56)
    any_print = False
    for iid in ALL_INDEX_IDS:
        try:
            v, _lo, _hi, _bound, ts, posted_at, exists = contract.functions.latestPrint(
                index_id_to_bytes32(iid)
            ).call()
        except Exception:  # the contract reverts "no print" until the first post
            print(f"  {iid:<9} {'no print yet':>16}   (run `make post-once`)")
            continue
        if not exists:  # pragma: no cover - the revert path above is the real guard
            print(f"  {iid:<9} {'no print yet':>16}")
            continue
        any_print = True
        print(f"  {iid:<9} {v / WAD:>16.5f}   ts {ts}  posted_at {posted_at}")

    # ⑤ explorer links (+ best-effort last PricePosted tx — views carry no tx hash,
    #    so scan the recent logs; skip quietly if the RPC declines the range)
    print("\n  explorer:")
    print(f"    oracle    {explorer}/address/{oracle}")
    if registry:
        print(f"    registry  {explorer}/address/{registry}")
    if any_print:
        try:
            head = w3.eth.block_number
            logs = w3.eth.get_logs(
                {
                    "address": oracle,
                    "topics": [Web3.to_hex(Web3.keccak(text=PRICE_POSTED_SIG))],
                    "fromBlock": max(0, head - 50_000),
                    "toBlock": "latest",
                }
            )
            if logs:
                tx = Web3.to_hex(logs[-1]["transactionHash"])
                print(f"    last post {explorer}/tx/{tx}")
        except Exception:
            print("    (PricePosted log scan skipped — the RPC declined the range)")

    if not ok:
        print("\n  ✗ verify FAILED — fix the ✗ checks above before going live.\n")
        sys.exit(1)
    print("\n  ✓ deploy verified — next: make api, then make post-once.\n")


if __name__ == "__main__":
    main()
