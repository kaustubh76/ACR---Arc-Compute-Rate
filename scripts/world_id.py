#!/usr/bin/env python3
"""Probe or enroll a World ID Agent Pass device flow — runnable by a judge.

    uv run python scripts/world_id.py probe      # does this issuer answer, and with what?
    uv run python scripts/world_id.py enroll     # learn the treasurer's (iss, sub)

Two commands over one flow, because enrollment IS a probe with the identity
check switched off: it exists to learn the pair that every later approval is
then held to.

WHAT PROBE PROVES, in order:

  1. Discovery answers, and its `issuer` is the one we configured. A redirect
     that lands on somebody else's identity provider is the one failure a
     correct signature check cannot catch afterwards.
  2. The assurance classes we ask for are classes this issuer ADVERTISES.
     `acr_values_supported` is exactly orb and orb-face on both production and
     sandbox; asking for an unadvertised class as an essential claim is not a
     preference the provider ignores, it is a requirement it cannot meet, and
     the refusal arrives as `access_denied` -- which is also what a human
     declining looks like.
  3. A real device authorization starts, and prints the code a person types.
  4. Polling honours the provider's own interval, adds five seconds on
     `slow_down`, and never treats a 503 or a 429 as an approval.
  5. The ID token passes every rung of the ladder, and the achieved `acr`,
     `amr` and `auth_time` are reported -- along with TIME TO FIRST SUCCESS,
     which both World bounties ask for in the integration debrief.

Nothing here prints the device code or the ID token. The device code is the
bearer of the whole approval and the token is a credential; a terminal
scrollback is not a vault.
"""

from __future__ import annotations

import argparse
import sys
import time

sys.path.insert(0, "services/index_api")

from acr_core import get_settings  # noqa: E402
from index_api.floatgate import ORB, ORB_FACE, _classes, deployed_vault  # noqa: E402
from index_api.floatguest import guest_agent_id  # noqa: E402
from index_api.humanid import mask  # noqa: E402
from index_api.worldauth import IdTokenValidator, treasurer_binding  # noqa: E402
from index_api.worldflow import DeviceFlow, widen  # noqa: E402


def _missing(s) -> list[str]:
    return [
        name
        for name, value in (
            ("ACR_WORLD_OIDC_ISSUER", s.world_oidc_issuer),
            ("ACR_WORLD_OIDC_CLIENT_ID", s.world_oidc_client_id),
            ("ACR_WORLD_OIDC_CLIENT_SECRET", s.world_oidc_client_secret),
        )
        if not value
    ]


def _obtain_token(s, *, kind: str, timeout_s: float):
    """Config → discovery → the device grant → the poll table → a raw token.

    Shared by every command on purpose. The poll table is the one piece that
    must not be copied: `slow_down` has to widen EVERY later interval, and a
    divergent second copy is exactly how that silently stops being true in one
    command while the other still looks right.

    Returns `(ctx, rc)`. `ctx` is None when `rc` is the exit code to use.
    """
    gaps = _missing(s)
    if gaps:
        print("✗ not configured yet. Set these and run again:")
        for name in gaps:
            print(f"    {name}")
        print("\n  Register a client at https://auth.world.org/portal:")
        print("    auth method client_secret_basic · any HTTPS redirect URI (required, never used)")
        print("    'Default accepted accounts' = Any · the secret is shown ONCE")
        return None, 2

    policy = kind == "policy"
    asked = _classes(
        s.world_policy_acr_values if policy else s.world_acr_values,
        (ORB_FACE, ORB) if policy else (ORB,),
    )

    flow = DeviceFlow(
        issuer=s.world_oidc_issuer,
        client_id=s.world_oidc_client_id,
        client_secret=s.world_oidc_client_secret,
        auth_method=s.world_oidc_auth_method or "basic",
    )

    print(f"1 · discovery  ({s.world_oidc_issuer})")
    try:
        advertised = flow.supported_acr()
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ discovery did not answer: {exc}")
        return None, 1
    print("  ✓ issuer matches, device grant advertised")
    for a in advertised:
        print(f"      advertises  {a}")
    for a in asked:
        mark = "✓" if a in advertised else "✗"
        print(f"      {mark} asking for {a}")
    unmet = [a for a in asked if advertised and a not in advertised]
    if unmet:
        print("\n  ✗ this issuer does not advertise " + ", ".join(unmet) + ".")
        print("    An essential claim it cannot meet is refused as `access_denied`, which is")
        print("    indistinguishable from the human declining. Fix the configured classes")
        print(f"    ({'ACR_WORLD_POLICY_ACR_VALUES' if policy else 'ACR_WORLD_ACR_VALUES'}) first.")
        return None, 1

    print(f"\n2 · starting a device authorization  (kind: {kind})")
    started_at = time.time()
    try:
        started = flow.start(asked)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ {exc}")
        return None, 1
    pub = started.public()
    print(f"  ✓ code  {started.user_code}")
    print(f"    open  {pub['verification_uri']}")
    print(f"    valid for {pub['expires_in']}s, poll every {started.interval}s")
    print("\n    Approve it in World App now. Nothing below happens until you do.")

    print("\n3 · polling")
    interval = started.interval
    deadline = started_at + min(timeout_s, pub["expires_in"])
    token = None
    while time.time() < deadline:
        time.sleep(interval)
        polled = flow.poll_once(started.device_code)
        if polled.kind == "pending":
            print(f"    … waiting ({int(time.time() - started_at)}s)")
            continue
        if polled.kind == "slow_down":
            interval = widen(interval, polled)
            print(f"    … the provider asked us to slow down; every later poll now {interval}s")
            continue
        if polled.kind != "token":
            print(f"  ✗ {polled.reason}")
            print(f"    {polled.sentence}")
            return None, 1
        token = polled.id_token
        break
    if token is None:
        print("  ✗ nothing was approved before the deadline")
        return None, 1

    return {
        "flow": flow,
        "token": token,
        "started_at": started_at,
        "asked": asked,
        "policy": policy,
    }, 0


def _run(*, enroll: bool, kind: str, timeout_s: float, settings=None, fake: bool = False) -> int:
    #: `settings` is how `--fake` points this at a local issuer WITHOUT
    #: mutating the environment: `get_settings()` is a process-wide singleton,
    #: so setting env vars here would leak into anything else in the process
    #: and the override would depend on import order.
    s = settings if settings is not None else get_settings()

    ctx, rc = _obtain_token(s, kind=kind, timeout_s=timeout_s)
    if ctx is None:
        return rc
    flow, token = ctx["flow"], ctx["token"]
    started_at, asked, policy = ctx["started_at"], ctx["asked"], ctx["policy"]

    elapsed = time.time() - started_at
    print(f"  ✓ a token came back after {elapsed:.1f}s")

    print("\n4 · validating")
    enrolled = (
        (s.world_treasurer_iss, s.world_treasurer_sub)
        if (s.world_treasurer_iss and s.world_treasurer_sub)
        else None
    )
    validator = IdTokenValidator(
        issuer=s.world_oidc_issuer,
        audience=s.world_oidc_client_id,
        accepted_acr=asked,
        jwks=flow.jwks,
        require_amr=("face",) if policy else (),
        forbid_amr=("mfa",) if policy else (),
        #: Enrollment is the one flow with no binding yet. Every other run is
        #: held to the enrolled pair, so a different human fails here.
        treasurer=None if enroll else enrolled,
        skew_s=s.world_auth_time_skew_s,
    )
    verdict = validator.check(token, opened_at=started_at)
    if not verdict.ok:
        print(f"  ✗ {verdict.reason}")
        if verdict.reason == "assurance_not_accepted":
            print("    The account authenticated, but not at a class we accept.")
        if verdict.reason == "not_the_enrolled_treasurer":
            print("    A verified human, but not the enrolled one. Run `enroll` to change that.")
        return 1

    c = verdict.claims
    print("  ✓ every rung passed")
    print(f"      acr        {c.acr}")
    print(f"      amr        {list(c.amr)}")
    print(f"      auth_time  {int(c.auth_time)} (after we asked, which is what fresh means)")
    print(f"      time to first success  {elapsed:.1f}s")

    if not enroll:
        print("\nworld-probe: THIS ISSUER WILL APPROVE A SPEND")
        if enrolled is None:
            print("  (no treasurer enrolled yet, so any verified human passes — run `enroll`)")
        return 0

    binding = treasurer_binding(c.iss, c.sub)
    print("\n5 · the enrollment")
    print(f"      iss  {c.iss}")
    print(f"      sub  {c.sub}")
    print(f"      treasurerBinding  {binding}")
    if fake:
        #: THE ONE THING --fake MUST NOT HAND OVER. `treasurerBinding` hashes
        #: the ISSUER STRING, `setTreasurerBinding` accepts a value exactly
        #: once from zero, and this issuer is `http://127.0.0.1:<an ephemeral
        #: port>`. Sending the value above would permanently bind a public vault
        #: to a socket that no longer exists -- not a bug you patch, a vault you
        #: redeploy, and the one-shot `wire()` is spent too. So the binding is
        #: computed (which is what proves this code path) and then withheld.
        print("\n  NOT FOR THE CHAIN. This binding hashes a localhost issuer on an")
        print("  ephemeral port. `setTreasurerBinding` takes a value ONCE from zero,")
        print("  so sending this one would strand the vault on an issuer that will")
        print("  not exist in a minute. The real value comes from a real client.")
        print("\nworld-enroll --fake: the enrollment path works. Nothing to send.")
        return 0
    print("\n  Add to .env, so every later approval is held to this person:")
    print(f"    ACR_WORLD_TREASURER_ISS={c.iss}")
    print(f"    ACR_WORLD_TREASURER_SUB={c.sub}")
    print("\n  Then the vault owner calls, ONCE and irreversibly:")
    print(f"    setTreasurerBinding({binding})")
    print("    A wrong value here is not a bug you patch, it is a vault you redeploy —")
    print("    the gate refuses to park anything until the chain's binding matches this.")
    print("\nworld-enroll: THE TREASURER IS KNOWN")
    return 0


def _run_guest(*, timeout_s: float, settings=None, fake: bool = False) -> int:
    """A verified human opens a guest budget on the vault, with no IDKit.

    WHY THIS EXISTS. The guest budget was built on World ID **Selfie Check**,
    which the World team confirmed on 2026-11-06 is no longer offered, and the
    browser path additionally needs an `rp_id` and a signing key only the
    Developer Portal issues. So `/float/join` cannot work and that entry is
    withdrawn. But the property a guest budget actually needs is "one per
    unique human", and **Agent Pass already answers exactly that**: `sub` is
    pairwise per client, stable, and orb-backed -- a stronger credential than
    the one that was withdrawn, not a weaker one.

    THE KEY. `keccak256("acr.guest::" + iss + 0x1f + sub)`, computed by handing
    `guest_agent_id` the same `iss ‖ 0x1f ‖ sub` string that `treasurer_binding`
    hashes. Deliberately the same shape as the treasurer's, and it needs no new
    function, no change to `guest_agent_id`, and nothing whatsoever on chain.

    THE DIFFERENCE FROM EVERY OTHER COMMAND is one argument: `treasurer=None`.
    Everywhere else an approval is held to the ONE enrolled treasurer, and a
    different human is refused `not_the_enrolled_treasurer`. A public door has
    to accept any verified human and give each their own budget, so this is the
    one place that check is deliberately absent -- and the assurance class is
    what carries the weight instead.

    THE SUBJECT IDENTIFIER IS NEVER PRINTED. It identifies a person to our
    client. Only its hash reaches the chain, and only `mask()` reaches a log.
    """
    s = settings if settings is not None else get_settings()

    ctx, rc = _obtain_token(s, kind="spend", timeout_s=timeout_s)
    if ctx is None:
        return rc
    flow, token = ctx["flow"], ctx["token"]
    started_at, asked = ctx["started_at"], ctx["asked"]

    elapsed = time.time() - started_at
    print(f"  ✓ a token came back after {elapsed:.1f}s")

    print("\n4 · validating — ANY verified human, not the enrolled treasurer")
    verdict = IdTokenValidator(
        issuer=s.world_oidc_issuer,
        audience=s.world_oidc_client_id,
        accepted_acr=asked,
        jwks=flow.jwks,
        #: The public door. See the docstring: this is the single argument that
        #: makes this command different from `probe` and `enroll`.
        treasurer=None,
        skew_s=s.world_auth_time_skew_s,
    ).check(token, opened_at=started_at)
    if not verdict.ok:
        print(f"  ✗ {verdict.reason}")
        if verdict.reason == "assurance_not_accepted":
            print("    The account authenticated, but not at a class we accept for a budget.")
        return 1
    c = verdict.claims
    print("  ✓ every rung passed")
    print(f"      acr        {c.acr}")
    print(f"      amr        {list(c.amr)}")
    print(f"      auth_time  {int(c.auth_time)} (after we asked, which is what fresh means)")
    print(f"      human      {mask(c.sub)}  ← masked; the identifier itself is never printed")

    print("\n5 · the guest budget")
    #: The same preimage shape as the treasurer binding, so the two cannot
    #: drift apart in anyone's head: iss, then 0x1f, then sub.
    agent_id = guest_agent_id(f"{c.iss}\x1f{c.sub}")
    print(f"      agent id   keccak('acr.guest::' + iss|sub) = 0x{agent_id.hex()}")
    print("                 the identifier never goes on chain, only this hash")

    rpc = getattr(s, "arc_rpc_url", "")
    if not rpc:
        print("  ✗ ACR_ARC_RPC_URL is unset, so there is no chain to register on")
        return 1
    if not s.float_guest_registrar_private_key:
        print("  ✗ ACR_FLOAT_GUEST_REGISTRAR_PRIVATE_KEY is unset")
        return 1

    from acr_oracle_client.float_vault import FloatVaultClient
    from acr_oracle_client.signer import LocalKeySigner
    from web3 import Web3

    try:
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 25}))
        chain_id = w3.eth.chain_id
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ the chain did not answer: {exc}")
        return 1
    vault_addr = s.float_vault_address or deployed_vault(chain_id)
    if not vault_addr:
        print(f"  ✗ no FloatVault for chain {chain_id}: set ACR_FLOAT_VAULT_ADDRESS")
        return 1
    vault = FloatVaultClient(
        w3, vault_addr, signer=LocalKeySigner(s.float_guest_registrar_private_key)
    )
    print(f"      vault      {vault_addr} on chain {chain_id}")

    pre = vault.guest_preflight()
    if pre != "ok":
        #: Expected on the public vault until the owner rotates the role. Name
        #: the transaction rather than leaving an operator to guess.
        print(f"  ✗ {pre}")
        print("    The identity half above is proven. What is missing is on chain:")
        print(f"      cast send {vault_addr} 'setGuestRegistrar(address)' \\")
        print(f"        {LocalKeySigner(s.float_guest_registrar_private_key).address} \\")
        print("        --rpc-url $R --private-key $OWNER_KEY")
        return 1
    print("  ✓ preflight ok · our signer IS the vault's guest registrar")

    before = vault.agent_of(agent_id)
    if before["exists"]:
        #: Not a failure. It is the one-per-human rule working, and it is the
        #: repeatable beat: it needs no second human to demonstrate.
        print("  ✓ this human ALREADY has a budget — refused, and nothing was widened")
        print(f"      {before['daily_cap_units'] / 1_000_000:.6f} USDC a day, guest={before['guest']}")
        print("\nworld-guest: ONE BUDGET PER HUMAN, ENFORCED BY THE CHAIN")
        return 0

    out = vault.register_guest(agent_id)
    after = vault.agent_of(agent_id)
    if not after["exists"]:
        print("  ✗ register_guest did not create the agent")
        return 1
    print(f"  ✓ budget issued · tx {out['tx']}")
    print(f"      {after['daily_cap_units'] / 1_000_000:.6f} USDC a day, "
          f"{after['per_request_units'] / 1_000_000:.6f} a request")
    if after["guest"]:
        print("      flagged a GUEST on chain, so it is revocable without touching a named agent")
    print("\nworld-guest: A VERIFIED HUMAN HAS A BUDGET")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="World ID Agent Pass: probe or enroll.")
    ap.add_argument("command", choices=("probe", "enroll", "guest"))
    ap.add_argument(
        "--kind",
        choices=("spend", "policy"),
        default="spend",
        help="which assurance list to ask for (policy is the stronger one)",
    )
    ap.add_argument("--timeout", type=float, default=300.0, help="seconds to wait for a human")
    ap.add_argument(
        "--fake",
        action="store_true",
        help="run against a LOCAL fake issuer instead of World (no credentials needed)",
    )
    ap.add_argument(
        "--fake-denies",
        action="store_true",
        help="with --fake, the issuer refuses, so the deny path can be seen",
    )
    a = ap.parse_args()

    if not a.fake:
        if a.command == "guest":
            return _run_guest(timeout_s=a.timeout)
        return _run(enroll=a.command == "enroll", kind=a.kind, timeout_s=a.timeout)

    #: WHY THIS MODE EXISTS. Everything below the device grant -- discovery
    #: validation, the essential-`acr` claims parameter, the poll table, the
    #: nine rungs -- had no end-to-end witness: the rehearsal injects a
    #: validator and skips `worldflow` entirely, and the tests stub the
    #: transport. So the one command an operator runs first had never been run
    #: successfully by anyone. This runs the SAME `_run` against a local
    #: issuer, so what is exercised is the shipping path and the only synthetic
    #: thing is who answers.
    #: Same cwd-relative convention as the `services/index_api` insert above:
    #: both make targets run from the repo root.
    sys.path.insert(0, "scripts")
    from fake_agent_pass import serve

    print("=" * 72)
    print("  --fake: this is NOT World. A local issuer answers, and it will say yes.")
    print("  It proves this command works. It proves nothing about World's issuer,")
    print("  so it can never fill the debrief's live timing rows.")
    print("=" * 72)
    with serve(pending_polls=1, deny=a.fake_denies) as fake:
        s = get_settings().model_copy(
            update={
                "world_oidc_issuer": fake.issuer,
                "world_oidc_client_id": "fake-agent-pass-client",
                "world_oidc_client_secret": "fake-agent-pass-secret",
                #: Enrolled to the fake's own subject, so the
                #: `not_the_enrolled_treasurer` rung actually FIRES rather than
                #: being skipped as it is when the pair is unset.
                "world_treasurer_iss": fake.issuer,
                "world_treasurer_sub": fake.sub,
            }
        )
        if a.command == "guest":
            rc = _run_guest(timeout_s=a.timeout, settings=s, fake=True)
        else:
            rc = _run(
                enroll=a.command == "enroll",
                kind=a.kind,
                timeout_s=a.timeout,
                settings=s,
                fake=True,
            )
        print()
        print(f"  ·· {len(fake.requests)} HTTP requests reached the fake issuer:")
        for r in fake.requests:
            print(f"       {r}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
