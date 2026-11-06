#!/usr/bin/env python3
"""Point the public vault at the press's keys, and bind it to the enrolled human.

    uv run python scripts/world_golive.py              # DRY RUN, reads only
    uv run python scripts/world_golive.py --send       # the three rotatable roles
    uv run python scripts/world_golive.py --send --bind-one-shot   # + the binding

WHY THIS EXISTS RATHER THAN FOUR PASTED COMMANDS. Three of these calls are
rotations and one is irreversible, and the irreversible one is the easiest to
get wrong at two in the morning. `setTreasurerBinding` accepts a value exactly
ONCE from zero and hashes the issuer string into it, so a wrong value is not a
bug you patch -- it is a vault you redeploy, and `wire()` is already spent.
Worse, a wrong binding FAILS SILENTLY in the direction that matters: the
approval stays valid and binds to the wrong person.

So this script is built around three properties:

  IDEMPOTENT -- every role is read from the chain first and skipped if already
  correct, so running it twice is safe and running it after a partial failure
  resumes rather than repeats.

  IT READS BACK -- a `cast send` that mined is not a role that changed. Every
  write is followed by a read of the same slot, and a mismatch is a failure.

  THE ONE-SHOT NEEDS A SEPARATE, EXPLICIT FLAG -- `--send` alone will NOT set
  the binding. It also refuses outright if the chain already holds a DIFFERENT
  non-zero binding, because at that point the vault is stranded and writing
  again is impossible; saying so is more useful than a revert.

Nothing here is World-specific magic: the binding preimage is recomputed from
`.env`'s enrolled pair with the same `treasurer_binding()` the gate uses, so the
value this prints is the value the gate will later demand.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services/index_api"))

from acr_core import get_settings  # noqa: E402
from acr_oracle_client.signer import LocalKeySigner  # noqa: E402
from index_api.floatgate import deployed_vault  # noqa: E402
from index_api.worldauth import treasurer_binding  # noqa: E402

OWNER_KEY_FILE = ROOT / "data/float-deployer-key.txt"
ZERO32 = "0x" + "00" * 32


def ok(m):
    print(f"  ✓ {m}")


def bad(m):
    print(f"  ✗ {m}")


def note(m):
    print(f"  · {m}")


def _send(w3, acct, fn, label: str):
    tx = fn.build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address), "gas": 600_000}
    )
    signed = w3.eth.account.sign_transaction(tx, acct.key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h)
    if r.status != 1:
        raise RuntimeError(f"{label} reverted")
    return r.transactionHash.hex()


def main() -> int:
    send = "--send" in sys.argv
    bind = "--bind-one-shot" in sys.argv

    from web3 import Web3

    s = get_settings()

    #: THE LOCAL CHECKS FIRST, because they are free and they name the real
    #: blocker. A fresh clone has no `.env` and no gitignored `data/`, and
    #: discovering that after a 25-second connection timeout to whatever
    #: `arc_rpc_url` defaulted to is a worse answer arriving later.
    if not OWNER_KEY_FILE.exists():
        bad(f"{OWNER_KEY_FILE.relative_to(ROOT)} is missing; only the owner can do this")
        bad("this script rotates roles on a deployed vault, so it needs that key")
        return 2

    rpc = getattr(s, "arc_rpc_url", "")
    if not rpc:
        bad("ACR_ARC_RPC_URL is unset")
        return 2
    try:
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 25}))
        chain_id = w3.eth.chain_id
    except Exception as exc:  # noqa: BLE001
        #: Found by running this from a clone: unguarded, it ended in a
        #: `requests.ConnectionError` traceback rather than a sentence. A
        #: go-live script that crashes before it can say what is missing is
        #: worse than useless, and the endpoint has to be in the message
        #: because the default is a localhost port that is somebody else's.
        bad(f"no chain answered at {rpc}: {type(exc).__name__}")
        return 2

    vault_addr = s.float_vault_address or deployed_vault(chain_id)
    if not vault_addr:
        bad(f"no FloatVault for chain {chain_id}: this is not a chain we deployed to")
        return 2

    owner = w3.eth.account.from_key(OWNER_KEY_FILE.read_text().strip())

    import json as _json

    from acr_oracle_client.float_vault import FloatVaultClient

    #: The REAL artifact ABI, not the client's. `FloatVaultClient` carries a
    #: deliberately narrow read/spend ABI with no owner functions in it, which
    #: is correct for a press that must never be able to rotate a role. This
    #: script is the one caller that needs them, so it loads the compiled
    #: artifact rather than hand-writing a second copy that could drift from
    #: the deployed bytecode.
    art = ROOT / "contracts/out/FloatVault.sol/FloatVault.json"
    if not art.exists():
        bad(f"{art.relative_to(ROOT)} is missing \u2014 run: cd contracts && forge build")
        return 2
    c = w3.eth.contract(address=w3.to_checksum_address(vault_addr),
                        abi=_json.loads(art.read_text())["abi"])

    print(f"vault   {vault_addr}  ·  chain {chain_id}")
    print(f"owner   {owner.address}")
    on_chain_owner = c.functions.owner().call()
    if on_chain_owner.lower() != owner.address.lower():
        bad(f"this key is not the vault owner (the vault says {on_chain_owner})")
        return 1
    bal = w3.eth.get_balance(owner.address) / 1e18
    ok(f"owner confirmed · {bal:.4f} USDC of gas (on Arc, gas IS USDC)")
    if bal < 0.05:
        bad("that is thin for four transactions; top up before sending")

    #: The press's keys, derived from `.env` rather than typed, so the addresses
    #: written on chain are necessarily the ones the press will actually sign
    #: with. A hand-copied address is the whole failure mode here.
    try:
        want = {
            "executor": LocalKeySigner(s.float_executor_private_key).address,
            "approver": LocalKeySigner(s.float_approver_private_key).address,
            "registrar": LocalKeySigner(s.float_guest_registrar_private_key).address,
        }
    except Exception as exc:  # noqa: BLE001
        bad(f"a press key would not load from .env: {type(exc).__name__}")
        return 2

    print("\n1 · the three rotatable roles")
    plan = [
        ("executor", "isExecutor", want["executor"],
         lambda: c.functions.isExecutor(want["executor"]).call(),
         lambda: c.functions.setExecutor(want["executor"], True), True),
        ("humanApprover", "humanApprover", want["approver"],
         lambda: c.functions.humanApprover().call(),
         lambda: c.functions.setApprover(want["approver"]), want["approver"]),
        ("guestRegistrar", "guestRegistrar", want["registrar"],
         lambda: c.functions.guestRegistrar().call(),
         lambda: c.functions.setGuestRegistrar(want["registrar"]), want["registrar"]),
    ]
    changed = 0
    for label, _slot, target, read, build, expect in plan:
        have = read()
        if (have is True) or (isinstance(have, str) and have.lower() == str(expect).lower()):
            ok(f"{label:14s} already {target} — skipped")
            continue
        shown = have if not isinstance(have, bool) else "false"
        if not send:
            note(f"{label:14s} is {shown}, wants {target}   (dry run)")
            changed += 1
            continue
        tx = _send(w3, owner, build(), label)
        after = read()
        if (after is True) or (isinstance(after, str) and after.lower() == str(expect).lower()):
            ok(f"{label:14s} → {target} · tx {tx[:18]}… · READ BACK and confirmed")
            changed += 1
        else:
            bad(f"{label} still reads {after} after a mined transaction")
            return 1

    print("\n2 · the treasurer binding (ONE-SHOT, irreversible)")
    if not (s.world_treasurer_iss and s.world_treasurer_sub):
        bad("ACR_WORLD_TREASURER_{ISS,SUB} are unset — run `make world-enroll` first")
        return 1
    want_bind = treasurer_binding(s.world_treasurer_iss, s.world_treasurer_sub)
    have_bind = "0x" + c.functions.treasurerBinding().call().hex()
    note(f"issuer    {s.world_treasurer_iss}")
    note("subject   (never printed; only its hash goes on chain)")
    note(f"computed  {want_bind}")
    note(f"on chain  {have_bind}")

    if have_bind.lower() == want_bind.lower():
        ok("already bound to the enrolled human — nothing to do")
    elif have_bind != ZERO32:
        bad("the chain holds a DIFFERENT non-zero binding.")
        bad("setTreasurerBinding is one-shot, so this vault cannot be rebound.")
        bad("It is stranded for this issuer; a new vault is the only repair.")
        return 1
    elif not (send and bind):
        note("still zero. Pass BOTH --send and --bind-one-shot to write it.")
        note("Withheld behind a second flag on purpose: a wrong value here is")
        note("not a bug you patch, it is a vault you redeploy, and it fails")
        note("silently — the approval stays valid and binds to the wrong person.")
    else:
        tx = _send(w3, owner, c.functions.setTreasurerBinding(bytes.fromhex(want_bind[2:])),
                   "setTreasurerBinding")
        back = "0x" + c.functions.treasurerBinding().call().hex()
        if back.lower() != want_bind.lower():
            bad(f"the chain reads {back} after the write")
            return 1
        ok(f"bound · tx {tx[:18]}… · READ BACK and confirmed")

    print("\n3 · what the gate says now")
    #: The real witness. Roles and a binding are inputs; this is the sentence the
    #: press itself will print, so it is the only thing that proves the work.
    status = FloatVaultClient(
        w3, vault_addr, signer=LocalKeySigner(s.float_executor_private_key)
    ).vault_status()
    (ok if status == "ok" else bad)(f"vault_status(): {status}")
    guest = FloatVaultClient(
        w3, vault_addr, signer=LocalKeySigner(s.float_guest_registrar_private_key)
    ).guest_preflight()
    (ok if guest == "ok" else bad)(f"guest_preflight(): {guest}")

    if not send:
        print(f"\nDRY RUN · {changed} role(s) would change. Re-run with --send.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
