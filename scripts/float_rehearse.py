#!/usr/bin/env python3
"""Walk the World ID journey end to end on a local chain, and say what a viewer sees.

    make rehearse-float                       # synthetic human, strict
    make rehearse-float ARGS=--report         # report instead of gating
    REHEARSE_WORLD=live make rehearse-float   # the real issuer, and a real phone

WHY THIS IS NOT `test_floatgate_onchain.py`. That suite proves each rung
refuses for its own reason, one assertion at a time. This answers a different
question -- *does the sequence we are about to show in front of people work
right now, and what does it put on screen* -- so it prints the VALUE at every
step rather than a tick, and it walks the legs in demo order rather than test
order. A step that "passed" while printing nothing a viewer could read is a
failure here.

IT SIGNS AND IT SPENDS, which is the exact opposite of
`scripts/rehearse_demo.py`'s rule, and the inversion is deliberate. That script
rehearses against live hosts where a transaction would cost real money, so it
reads and never writes. This one runs on a throwaway local chain where moving
USDC and watching it land IS the thing being rehearsed. It cannot touch a
public network: it refuses any chain id that is not anvil's, before it holds a
key.

THE SYNTHETIC HUMAN IS NOT A MOCK OF OUR OWN CODE. `IdTokenValidator` takes its
JWKS as a callable, so the default mode mints a genuine RS256 id token with a
locally generated key and hands the matching public JWK to the same nine-rung
ladder a live token goes through -- signature, issuer, audience, expiry,
assurance class, auth_time window and the enrolled-treasurer check all run for
real. What is synthetic is the ISSUER, not the validation. `REHEARSE_WORLD=live`
swaps in the device flow and a phone and leaves every other line alone, so the
rehearsal and the recording are the same script.

THE RIG IS DEPLOYED FRESH, and deliberately mirrors the suite's. It is not the
peer's `float-local` stack: that hardcodes port 8545, and this must not fight
another session for a port. The wiring is read BACK off the chain and printed
(step 1) rather than assumed, so if the two rigs ever drift the rehearsal says
so instead of hiding it.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages" / "acr_oracle_client"))
sys.path.insert(0, str(ROOT / "services" / "index_api"))

RPC = os.environ.get("REHEARSE_RPC", os.environ.get("ACR_TEST_RPC", "http://127.0.0.1:8546"))
#: Strict by default, like `rehearse_demo.py`: at rehearsal time "I could not
#: run the step" is the most important failure, not a thing to shrug at.
STRICT = os.environ.get("REHEARSE_STRICT", "1") != "0" and "--report" not in sys.argv
WORLD = os.environ.get("REHEARSE_WORLD", "synthetic")

#: anvil's chain id. A guard, not a setting: this script signs and spends.
ANVIL_CHAIN_ID = 31337

_OUT = ROOT / "contracts" / "out"
_ARTS = {
    "vault": _OUT / "FloatVault.sol/FloatVault.json",
    "usdc": _OUT / "MockUSDC.sol/MockUSDC.json",
    "prices": _OUT / "FloatPrintStore.sol/FloatPrintStore.json",
}

#: One key per role, because the vault refuses `approver is an executor` and a
#: shared key would hide exactly the separation this demo is about.
KEYS = {
    "owner": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "executor": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "approver": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "registrar": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "seller": "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "agent": "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
}
INDEX = b"ACR-GPU".ljust(32, b"\x00")
AGENT_ID = b"scout".ljust(32, b"\x00")
#: The vault's own kind constants: 1 spend, 2 policy.
KIND_SPEND, KIND_POLICY = 1, 2
GUEST_CAP = 2_000_000
TTL_S = 300

#: The synthetic issuer. Shaped like World's so the ladder's issuer check is a
#: real comparison, but unmistakably not World: nothing minted here could ever
#: be confused for a production token in a log.
SYNTH_ISS = "https://rehearsal.invalid/oidc"
SYNTH_SUB = "rehearsal-treasurer-0001"
SYNTH_AUD = "acr-float-rehearsal"
ORB = "https://world.org/oidc/acr/orb"
ORB_FACE = "https://world.org/oidc/acr/orb-face"

fails: list[str] = []
notes: list[str] = []
timings: list[tuple[str, float]] = []


# --- saying what happened ---------------------------------------------------


def step(n: str) -> None:
    print(f"\n\033[1m{n}\033[0m" if sys.stdout.isatty() else f"\n{n}")


def ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def bad(msg: str) -> None:
    print(f"  ✗ {msg}")
    fails.append(msg)


def note(msg: str) -> None:
    print(f"  · {msg}")
    notes.append(msg)


def events_of(contract, name: str, receipt) -> list:
    """Every `name` event in THIS transaction's own logs.

    THE TRANSACTION IS THE AUTHORITY, and for `requestSpend` nothing else can
    be. It emits `Denied` and RETURNS rather than reverting -- our own design,
    because the gate needs the reason -- so a refusal mines with status 1 and
    anything reading `receipt.status` learns nothing from it. A pre-flight
    `classify` cannot stand in either: the keeper can post a print between the
    view and the write, and then the view is describing a chain state that has
    already moved.

    The peer hit this on the overnight tape, where a refused spend printed
    "PAID receipt #null" for a cycle. A demo that reports success while moving
    no money is worse than one that stops, because it reads as the product
    working.
    """
    from web3.logs import DISCARD

    return list(contract.events[name]().process_receipt(receipt, errors=DISCARD))


def revert_reason(exc: Exception) -> str:
    """The vault's own sentence, out of web3's tuple-shaped error string.

    Splitting on "revert" is wrong and printed `ed` for a whole run: the
    message says "execution reverted: bad approval", so the naive split lands
    inside the word. Matched explicitly instead.
    """
    import re

    m = re.search(r"execution reverted:?\s*([^']*)", str(exc))
    return (m.group(1) if m else str(exc)).strip().strip("',\"") or "no reason given"


def usdc(units: int) -> str:
    return f"{units / 1e6:,.6f} USDC"


# --- the chain --------------------------------------------------------------


def connect():
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 10}))
    if not w3.is_connected():
        bad(f"no node at {RPC} -- start one with: anvil --port 8546")
        return None
    cid = w3.eth.chain_id
    if cid != ANVIL_CHAIN_ID:
        #: Refused before a key is loaded. A rehearsal that signs and spends
        #: has no business on a chain it did not expect.
        bad(f"chain id {cid} is not anvil's {ANVIL_CHAIN_ID} -- refusing to sign anything here")
        return None
    ok(f"anvil at {RPC}, chain {cid}, head {w3.eth.block_number}")
    return w3


def deploy(w3, art: Path, owner, *args):
    a = json.loads(art.read_text())
    c = w3.eth.contract(abi=a["abi"], bytecode=a["bytecode"]["object"])
    tx = c.constructor(*args).build_transaction(
        {
            "from": owner.address,
            "nonce": w3.eth.get_transaction_count(owner.address),
            "gas": 9_000_000,
        }
    )
    signed = w3.eth.account.sign_transaction(tx, owner.key)
    r = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
    if r.status != 1:
        raise RuntimeError(f"deploying {art.stem} reverted")
    return w3.eth.contract(address=r.contractAddress, abi=a["abi"])


def send(w3, acct, fn):
    tx = fn.build_transaction(
        {
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": 3_000_000,
        }
    )
    signed = w3.eth.account.sign_transaction(tx, acct.key)
    r = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
    if r.status != 1:
        raise RuntimeError("transaction reverted")
    return r


def warp(w3, seconds: int) -> None:
    """Move the CHAIN's clock. The vault's TTL is chain time, not ours."""
    w3.provider.make_request("evm_increaseTime", [seconds])
    w3.provider.make_request("evm_mine", [])


# --- the synthetic human ----------------------------------------------------


def synth_keypair():
    from cryptography.hazmat.primitives.asymmetric import rsa

    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def jwk_of(key, kid: str = "rehearsal-1") -> dict:
    import base64

    n = key.public_key().public_numbers()

    def b(i: int) -> str:
        raw = i.to_bytes((i.bit_length() + 7) // 8, "big")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return {"kty": "RSA", "kid": kid, "alg": "RS256", "n": b(n.n), "e": b(n.e)}


def mint_token(key, claims: dict, kid: str = "rehearsal-1") -> str:
    """A real RS256 token. The ladder verifies this exactly as it would World's."""
    import base64

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    def enc(d: dict) -> str:
        raw = json.dumps(d, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    signed = f"{enc({'alg': 'RS256', 'typ': 'JWT', 'kid': kid})}.{enc(claims)}".encode()
    sig = key.sign(signed, padding.PKCS1v15(), hashes.SHA256())
    return f"{signed.decode()}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def synth_claims(*, sub: str = SYNTH_SUB, acr: str = ORB, now: float | None = None) -> dict:
    at = int(time.time() if now is None else now)
    return {
        "iss": SYNTH_ISS,
        "sub": sub,
        "aud": SYNTH_AUD,
        "exp": at + 600,
        "iat": at,
        "acr": acr,
        "amr": ["orb"],
        "auth_time": at,
    }


# --- the rig ----------------------------------------------------------------


def stand_up(w3):
    from acr_oracle_client.float_vault import FloatVaultClient
    from acr_oracle_client.signer import LocalKeySigner
    from index_api.worldauth import treasurer_binding

    acct = {k: w3.eth.account.from_key(v) for k, v in KEYS.items()}
    owner = acct["owner"]

    usdc_c = deploy(w3, _ARTS["usdc"], owner)
    prices = deploy(w3, _ARTS["prices"], owner)
    vault = deploy(w3, _ARTS["vault"], owner, usdc_c.address, prices.address, GUEST_CAP)

    send(w3, owner, prices.functions.setSigner(owner.address, True))
    send(w3, owner, prices.functions.setPrint(INDEX, 3_000_000_000_000_000, 250))
    send(
        w3,
        owner,
        vault.functions.wire(
            acct["executor"].address,
            owner.address,
            acct["approver"].address,
            acct["registrar"].address,
            owner.address,
            "0x" + "00" * 20,
            "0x" + "00" * 20,
        ),
    )
    policy = (100, 1000, 3600, 1500, 1000, 3000, 48, 25_000_000)
    send(
        w3, owner, vault.functions.setPolicy(policy, b"\x11" * 32, 0, 0, b"\x00" * 32, b"\x00" * 32)
    )
    #: perRequest deliberately tiny so an ordinary quote escalates -- the
    #: threshold is what the demo is about, not the daily cap.
    send(
        w3,
        owner,
        vault.functions.setAgent(
            AGENT_ID, 500_000_000, 1_000_000, False, b"\x22" * 32, 0, 0, b"\x00" * 32, b"\x00" * 32
        ),
    )
    send(
        w3,
        owner,
        vault.functions.allowSeller(
            AGENT_ID, acct["seller"].address, True, 0, 0, b"\x00" * 32, b"\x00" * 32
        ),
    )
    send(w3, owner, usdc_c.functions.mint(vault.address, 1_000_000_000))

    #: The REAL binding of the synthetic human, not a fixture constant. This is
    #: what makes "wrong human" a genuine refusal later rather than a staged
    #: one: the chain commits to keccak(iss, sub) of this exact pair, one-shot.
    binding = bytes.fromhex(treasurer_binding(SYNTH_ISS, SYNTH_SUB)[2:])
    send(w3, owner, vault.functions.setTreasurerBinding(binding))

    return {
        "w3": w3,
        "acct": acct,
        "usdc": usdc_c,
        "prices": prices,
        "vault": vault,
        "binding": binding,
        "client": FloatVaultClient(w3, vault.address, signer=LocalKeySigner(KEYS["executor"])),
        "registrar_client": FloatVaultClient(
            w3, vault.address, signer=LocalKeySigner(KEYS["registrar"])
        ),
        "approver": LocalKeySigner(KEYS["approver"]),
    }


def req_for(rig, *, quote: int, nonce: bytes, agent_id: bytes = AGENT_ID):
    from acr_oracle_client.float_vault import SpendReq

    return SpendReq(
        agent_id=agent_id,
        seller=rig["acct"]["seller"].address,
        index=INDEX,
        units=6000,
        quote_total=quote,
        print_id=1,
        nonce=nonce,
    )


def fair_of(rig) -> int:
    """Ask the chain what fair is rather than reimplementing their arithmetic."""
    return rig["client"].classify(req_for(rig, quote=1, nonce=b"\xaa" * 32))["fair_usdc"]


# --- the legs ---------------------------------------------------------------


def leg_wiring(rig) -> None:
    """Read the roles BACK off the chain. An asserted role is not a proven one."""
    step("1 · the roles, read back off the chain")
    v, a = rig["vault"], rig["acct"]
    approver = v.functions.humanApprover().call()
    registrar = v.functions.guestRegistrar().call()
    for label, got, want in (
        ("approver", approver, a["approver"].address),
        ("registrar", registrar, a["registrar"].address),
    ):
        if got.lower() == want.lower():
            ok(f"{label:<10} {got}")
        else:
            bad(f"{label} is {got}, not the {label} key {want}")
    if v.functions.isExecutor(a["executor"].address).call():
        ok(f"executor   {a['executor'].address}")
    else:
        bad(f"{a['executor'].address} is not an executor on this vault")
    if approver.lower() != a["executor"].address.lower():
        ok("approver and executor are different keys, so one hot key cannot self-approve")
    else:
        bad("approver == executor: one compromised key could open and approve its own spend")
    onchain = bytes(v.functions.treasurerBinding().call())
    if onchain == rig["binding"]:
        ok(f"treasurer binding {onchain.hex()[:18]}… = keccak(iss, sub) of the enrolled human")
    else:
        bad(f"binding on chain {onchain.hex()[:18]}… is not the enrolled pair's")
    cap = rig["client"].guest_daily_cap()
    ok(f"guest budget {usdc(cap)} a day, fixed at deploy")


def leg_agent_holds_nothing(rig, when: str) -> int:
    step(f"2 · what the agent's own wallet holds — {when}")
    bal = rig["usdc"].functions.balanceOf(rig["acct"]["agent"].address).call()
    if bal == 0:
        ok(f"agent wallet {rig['acct']['agent'].address} holds {usdc(bal)}")
    else:
        bad(f"the agent holds {usdc(bal)} — the whole claim is that it holds nothing")
    return bal


def leg_in_policy(rig) -> None:
    """The contrast case. Without this the demo cannot show what 'in policy' means."""
    step("3 · a spend INSIDE policy pays straight through")
    c = rig["client"]
    fair = fair_of(rig)
    #: Under the agent's 1 USDC perRequest limit, so no human is involved.
    req = req_for(rig, quote=900_000, nonce=b"\x31" * 32)
    verdict = c.classify(req)
    before = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    if verdict["code"] != 0:
        note(f"the small quote still classifies {verdict['reason']!r} (code {verdict['code']})")
        return
    ok(f"classify says allowed · fair {usdc(fair)} for 6000 units · print #{verdict['print_id']}")
    #: Driven straight at the vault: the gate only ever reaches for
    #: `requestSpend` in the OUT of policy case, so the client has no method
    #: for this one, and inventing a surface to make a rehearsal tidier would
    #: be inventing a surface.
    v = rig["vault"]
    sent = send(rig["w3"], rig["acct"]["executor"], v.functions.requestSpend(req.as_tuple()))
    after = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    moved = after - before

    #: The RECEIPT decides this, not the status and not the `classify` above.
    #: Judging it by either would print a green "moved 0.000000, no human
    #: asked" over a refusal.
    if denied := events_of(v, "Denied", sent):
        d = denied[0]["args"]
        bad(
            f"the vault REFUSED this in-policy spend: {d['reason']!r} (code {d['code']}) "
            f"\u00b7 quote {usdc(d['quote'])} against fair {usdc(d['fair'])}"
        )
        return
    paid = events_of(v, "Receipt", sent)
    if not paid:
        bad("requestSpend emitted neither Receipt nor Denied, so nothing here is trustworthy")
        return
    got = paid[0]["args"]
    ok(
        f"Receipt #{got['id']} \u00b7 the vault's own record: quote {usdc(got['quote'])}, "
        f"fair {usdc(got['fair'])}, premium {got['premiumBps']} bp"
    )
    if got["humanApproved"]:
        bad("the Receipt says a human approved this, but nobody was asked")
        return
    #: And the two sources have to agree. When they do not, the disagreement is
    #: the finding -- that is the fingerprint of a print landing mid-tick.
    if moved != req.quote_total:
        bad(
            f"a Receipt was emitted but the seller moved {usdc(moved)}, "
            f"not the {usdc(req.quote_total)} it names"
        )
        return
    ok(f"seller {usdc(before)} -> {usdc(after)} \u00b7 moved {usdc(moved)}, no human asked")


def leg_park(rig, *, nonce: bytes, label: str, n: str = "4") -> dict:
    step(f"{n} · a spend OUTSIDE policy is parked, not refused — {label}")
    c = rig["client"]
    fair = fair_of(rig)
    #: 3% over fair: inside the human-approvable band, over the agent's own
    #: per-request limit. The interesting case -- not refused, not allowed.
    req = req_for(rig, quote=fair * 103 // 100, nonce=nonce)
    verdict = c.classify(req)
    ok(f"classify refuses it: {verdict['reason']!r} (code {verdict['code']})")
    ok(
        f"quote {usdc(req.quote_total)} against a fair {usdc(fair)} · premium {(req.quote_total / fair - 1) * 100:.2f}%"
    )
    #: Ask the VAULT and not only the view -- but on a THROWAWAY nonce, and
    #: this is the whole subtlety of the escalation path. `requestSpend` burns
    #: the nonce of anything it refuses (`FloatVault.sol:784`, every code except
    #: D_PER_REQUEST) so a refused request cannot become payable later when a
    #: cap rolls or a price moves. This one refuses with code 10, `quote
    #: exceeds ACR fair band` -- NOT the per-request code -- so sending the
    #: real request here would burn the nonce of the very request a human is
    #: about to be asked to clear, and `executeApproved` would then revert
    #: "replayed request" AFTER they approved it.
    #:
    #: Which is exactly why `floatgate.py:254` parks from `classify`, a view.
    #: "Ask the authority, not the symptom" is the right rule for claiming a
    #: payment HAPPENED; it is the wrong rule here, because the only way to ask
    #: this authority is to spend the thing you are asking about. The chain
    #: still has the last word -- `executeApproved` re-checks band, cap and
    #: print -- so a stale view can never cause an overpayment, only a park
    #: that did not need to happen.
    v = rig["vault"]
    probe = req_for(rig, quote=req.quote_total, nonce=bytes(b ^ 0xFF for b in nonce))
    attempt = send(rig["w3"], rig["acct"]["executor"], v.functions.requestSpend(probe.as_tuple()))
    if events_of(v, "Receipt", attempt):
        bad("the vault PAID an out-of-policy quote, so there is nothing to park")
        return {}
    refusal = events_of(v, "Denied", attempt)
    if not refusal:
        bad("requestSpend neither paid nor denied, so the park below would prove nothing")
        return {}
    d = refusal[0]["args"]
    ok(f"the vault itself refuses this shape: {d['reason']!r} (code {d['code']})")
    if not v.functions.usedNonce(probe.nonce).call():
        bad("the refusal did not burn the probe's nonce, so it could become payable later")
        return {}
    ok("that refusal BURNED the probe's nonce, so it can never be paid later")
    if v.functions.usedNonce(req.nonce).call():
        bad("the request about to be parked has a burned nonce, so no human could clear it")
        return {}
    ok("the request being parked still holds its nonce, which is what a human will clear")
    parked = c.open_checkpoint(agent_id=req.agent_id, req_hash=c.req_hash(req), kind=1, ttl_s=TTL_S)
    cp = c.checkpoint_of(parked["id"])
    ok(f"checkpoint #{parked['id']} open on chain · tx {parked['tx'][:18]}…")
    ok(
        f"  agent    {parked['agent_id'].rstrip(chr(0).encode()).decode(errors='replace')!r} (stored, so the record cannot lie)"
    )
    ok(f"  reqHash  {parked['req_hash'].hex()[:18]}…")
    ok(f"  expires  chain time {cp.expires_at} · {TTL_S}s from now")
    return {"id": parked["id"], "req": req, "fair": fair}


def leg_approve(rig, parked: dict, key, *, now: float | None = None) -> None:
    step("5 · the human approves, and only then does money move")
    c = rig["client"]
    opened = time.time() if now is None else now
    token = mint_token(key, synth_claims(now=opened))
    verdict = validate(rig, key, token, opened_at=opened)
    if verdict.refused:
        bad(f"the synthetic human was refused: {verdict.reason}")
        return
    ok(
        f"token accepted · acr {verdict.claims.acr.rsplit('/', 1)[-1]} · amr {list(verdict.claims.amr)}"
    )
    ok(f"binding from the token {verdict.claims.binding()[:18]}… matches the chain's")

    cp = c.checkpoint_of(parked["id"])
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=c.req_hash(parked["req"]),
        expires_at=cp.expires_at,
        signer=rig["approver"],
    )
    ok(
        "signature cross-checked against the chain's own approvalDigest and recovered to the approver"
    )
    before = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    out = c.execute_approved(cp_id=parked["id"], req=parked["req"], v=v, r=r, s=s)
    after = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    moved = after - before
    if moved == parked["req"].quote_total:
        ok(f"seller {usdc(before)} -> {usdc(after)} · moved {usdc(moved)} · tx {out['tx'][:18]}…")
    else:
        bad(
            f"seller moved {usdc(moved)} but the approved quote was {usdc(parked['req'].quote_total)}"
        )
    final = c.checkpoint_of(parked["id"])
    if final.status == 1:
        ok("checkpoint CONSUMED — the approval is spent and cannot be replayed")
    else:
        bad(f"checkpoint status {final.status} after a successful execute, expected CONSUMED")


def validate(rig, key, token: str, *, opened_at: float, accepted=(ORB,)):
    """The same nine-rung ladder a live token goes through, local JWKS and all.

    `accepted` is a parameter because the policy path is held to a DIFFERENT
    list from the spend path, and the whole question leg 11 asks is whether
    that separation is real.
    """
    from index_api.worldauth import IdTokenValidator

    return IdTokenValidator(
        issuer=SYNTH_ISS,
        audience=SYNTH_AUD,
        accepted_acr=list(accepted),
        jwks=lambda: [jwk_of(key)],
        treasurer=(SYNTH_ISS, SYNTH_SUB),
    ).check(token, opened_at=opened_at)


def leg_denied(rig, key) -> None:
    step("6 · DENIED — the human says no, and the refusal is on chain")
    c = rig["client"]
    parked = leg_park(rig, nonce=b"\x32" * 32, label="for the denial", n="6a")
    if not parked:
        return
    before = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    #: What World actually returns when a human taps Deny -- and also when the
    #: essential assurance class is unmet, and also on a subject mismatch. One
    #: code, three meanings, which is why the reason recorded names all three.
    reason = "access_denied: refused, assurance unmet, or a different human"
    out = c.resolve_checkpoint(cp_id=parked["id"], outcome="denied", reason=reason)
    after = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    cp = c.checkpoint_of(parked["id"])
    if cp.status == 2:
        ok(f"checkpoint #{parked['id']} DENIED on chain · tx {out['tx'][:18]}…")
    else:
        bad(f"checkpoint status {cp.status} after a denial, expected DENIED")
    if after == before:
        ok(f"seller unchanged at {usdc(after)} — a denial moves nothing")
    else:
        bad(f"seller moved {usdc(after - before)} on a DENIED checkpoint")
    ok(f"recorded reason: {reason}")


def leg_expired(rig) -> None:
    step("7 · EXPIRED — nobody answered, so the money stays put")
    c, w3 = rig["client"], rig["w3"]
    parked = leg_park(rig, nonce=b"\x33" * 32, label="for the expiry", n="7a")
    if not parked:
        return
    before = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    warp(w3, TTL_S + 60)
    ok(f"chain clock moved past the {TTL_S}s window (chain time, not ours)")
    out = c.resolve_checkpoint(
        cp_id=parked["id"], outcome="expired", reason="the window closed unanswered"
    )
    cp = c.checkpoint_of(parked["id"])
    after = rig["usdc"].functions.balanceOf(rig["acct"]["seller"].address).call()
    if cp.status == 3:
        ok(f"checkpoint #{parked['id']} EXPIRED on chain · tx {out['tx'][:18]}…")
    else:
        bad(f"checkpoint status {cp.status} after expiry, expected EXPIRED")
    if after == before:
        ok(f"seller unchanged at {usdc(after)}")
    else:
        bad(f"seller moved {usdc(after - before)} on an EXPIRED checkpoint")


def leg_wrong_human(rig, key) -> None:
    step("8 · WRONG HUMAN — a real, valid proof from the wrong person")
    opened = time.time()
    #: A genuinely well-formed token: right issuer, right audience, right
    #: assurance class, in date, correctly signed. Only the subject differs.
    token = mint_token(key, synth_claims(sub="someone-else-entirely", now=opened))
    verdict = validate(rig, key, token, opened_at=opened)
    if verdict.refused and verdict.reason == "not_the_enrolled_treasurer":
        ok("refused: not_the_enrolled_treasurer")
        ok("the signature was valid and the class was right — only the person was wrong")
    else:
        bad(f"a stranger's valid token was not refused as expected: {verdict.reason}")
    for label, claims in (
        (
            "an unaccepted assurance class",
            synth_claims(acr="https://world.org/oidc/acr/device", now=opened),
        ),
        ("a token minted 10 minutes before the checkpoint opened", synth_claims(now=opened - 600)),
    ):
        v = validate(rig, key, mint_token(key, claims), opened_at=opened)
        if v.refused:
            ok(f"{label}: refused as {v.reason}")
        else:
            bad(f"{label} was ACCEPTED")


def leg_agent_mismatch(rig) -> None:
    step("9 · AGENT MISMATCH — the chain refuses a swapped agent")
    c = rig["client"]
    fair = fair_of(rig)
    req = req_for(rig, quote=fair * 103 // 100, nonce=b"\x34" * 32)
    parked = c.open_checkpoint(agent_id=req.agent_id, req_hash=c.req_hash(req), kind=1, ttl_s=TTL_S)
    other = req_for(
        rig, quote=req.quote_total, nonce=b"\x35" * 32, agent_id=b"waster".ljust(32, b"\x00")
    )
    cp = c.checkpoint_of(parked["id"])
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=c.req_hash(other),
        expires_at=cp.expires_at,
        signer=rig["approver"],
    )
    try:
        c.execute_approved(cp_id=parked["id"], req=other, v=v, r=r, s=s)
        bad("a checkpoint opened for 'scout' released a payment for 'waster'")
    except Exception as exc:
        if "agent mismatch" in str(exc):
            ok("refused: agent mismatch — the stored agent is the one that must be paid")
            still = c.checkpoint_of(parked["id"])
            if still.status == 0:
                ok(f"checkpoint #{parked['id']} still OPEN for 'scout': the whole tx rolled back")
            else:
                bad(f"checkpoint status {still.status} after a rolled-back execute")
        else:
            bad(f"refused for the wrong reason: {str(exc)[:90]}")


def leg_guest(rig) -> None:
    step("10 · one guest budget per human, the chain as the authority")
    from index_api.floatguest import guest_agent_id

    #: `registerGuest` is `require(msg.sender == guestRegistrar)`, and the
    #: rehearsal's default client signs as the EXECUTOR -- deliberately, since
    #: the vault refuses a shared key. So the join leg gets its own client on
    #: the registrar key, which is exactly how the press is wired: three keys,
    #: three capabilities, and the one that issues budgets cannot release a
    #: payment.
    c = rig["registrar_client"]
    pre = c.guest_preflight()
    if pre != "ok":
        note(f"guest preflight says {pre!r}, so the join leg stands down")
        return
    ok(f"preflight ok \u00b7 our signer IS the vault's guest registrar {c.guest_registrar()}")

    #: THE GUEST SERVER, not just the chain call. Until this existed the leg
    #: drove `register_guest` directly from a hardcoded nullifier, which
    #: proved the vault and skipped every refusal in front of it -- and the
    #: submission still said the whole thing ran "end to end" here.
    #:
    #: What is synthetic: World's answer, and only World's answer. The nonce
    #: binding, the environment observation, the v4 nullifier normalisation,
    #: the floor, the ledger and the chain are the shipping code, reached
    #: through the real httpx client. The rp_context signing on the browser
    #: side is pinned separately, by apps/terminal/lib/rpContext.test.ts.
    import httpx
    from index_api.floatguest import GuestError, GuestGate, verify_uniqueness_proof

    #: Decimal on the wire, as the v4 API returns it -- so `_as_hex32` has
    #: something real to normalise rather than being handed its own output.
    HUMAN_DECIMAL = "57896044618658097711785492504343953926634992332820282019728"

    #: Steerable so a SECOND human can be presented. Without that, every
    #: refusal below could be the one-per-human rule wearing another name.
    answering = {"nullifier": HUMAN_DECIMAL}

    def fake_world(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "success": True,
                "nullifier": answering["nullifier"],
                "environment": "production",
            },
        )

    def verify(payload, *, rp_id, environment, **kw):
        return verify_uniqueness_proof(
            payload,
            rp_id=rp_id,
            environment=environment,
            transport=httpx.MockTransport(fake_world),
        )

    gate = GuestGate(
        vault=c,
        rp_id="rp_00000000000000ac",
        environment="production",
        min_sybil=5,
        verify=verify,
    )
    wallet = rig["acct"]["agent"].address
    proof = {"responses": [{"issuer_schema_id": 11, "sybil_score": 9}]}

    #: Derive the id the SAME way the server will, so `before` is a real read
    #: of the chain rather than an assumption about it -- and so the server's
    #: answer can be cross-checked against an independently computed value.
    from index_api.humanid import _as_hex32

    nullifier = _as_hex32(HUMAN_DECIMAL)
    aid = guest_agent_id(nullifier)
    before = c.agent_of(aid)
    ok(
        f"agent id keccak('acr.guest::' + nullifier) = {aid.hex()[:18]}… "
        "(the nullifier never goes on chain)"
    )

    gate.bind("nonce-one", wallet)
    issued = gate.claim({**proof, "nonce": "nonce-one"})
    if bytes.fromhex(issued["agent_id"][2:]) != aid:
        bad(f"the server issued against {issued['agent_id'][:18]}…, not the derived id")
    ok(f"the server's agent id matches the one derived here, independently")
    ok(f"what came back to the browser names the human only as {issued['human']!r}")
    after = c.agent_of(aid)
    out = {"tx": issued["tx"]}
    if not before["exists"] and after["exists"]:
        ok(
            f"budget issued · {usdc(after['daily_cap_units'])} a day, "
            f"{usdc(after['per_request_units'])} a request · tx {out['tx'][:18]}…"
        )
        if after["guest"]:
            ok("flagged a GUEST on chain, so it is revocable without touching a named agent")
    else:
        bad(
            f"register_guest did not create the agent (before {before['exists']}, after {after['exists']})"
        )
    #: LAYER 2 -- our ledger plus a chain READ. The server refuses before it
    #: spends any gas, which is the layer a visitor actually meets.
    gate.bind("nonce-two", wallet)
    try:
        gate.claim({**proof, "nonce": "nonce-two"})
        bad("the server issued the same human a SECOND budget")
    except GuestError as e:
        if e.reason == "one_guest_budget_per_human":
            ok(f"the same human, asking again: refused by the SERVER · {e.reason}")
        else:
            bad(f"the server refused, but for the wrong reason: {e.reason}")

    #: A nonce is spent either way, so a refused request cannot be retried.
    try:
        gate.claim({**proof, "nonce": "nonce-two"})
        bad("a spent nonce was accepted a second time")
    except GuestError as e:
        if e.reason == "unknown_or_expired_request":
            ok(f"that join request is spent, and spent on sight · {e.reason}")
        else:
            bad(f"a spent nonce gave {e.reason}")

    #: The floor, against a DIFFERENT human, so this cannot be layer 2 again.
    answering["nullifier"] = "42"
    gate.bind("nonce-three", wallet)
    try:
        gate.claim({"responses": [{"issuer_schema_id": 11, "sybil_score": 1}], "nonce": "nonce-three"})
        bad("a credential below the floor was issued a budget")
    except GuestError as e:
        if e.reason == "below_sybil_floor":
            ok(f"a different human, below the configured floor: refused · {e.reason}")
        else:
            bad(f"the floor gave {e.reason}")

    #: LAYER 3 -- the chain itself, asked directly, with the server bypassed.
    try:
        c.register_guest(aid)
        bad("the same human got a SECOND budget")
    except Exception as exc:
        #: The STATE is the assertion; the sentence is only what we SHOW. A
        #: revert string is not an API -- deciding on one is the coupling that
        #: broke the checkpoint read -- but it is exactly what a viewer should
        #: hear, so print the vault's own words and judge the chain's state.
        still = c.agent_of(aid)
        if (
            still["exists"]
            and still["guest"]
            and still["daily_cap_units"] == after["daily_cap_units"]
        ):
            ok(f"the same human, asking again: refused by the chain · {revert_reason(exc)}")
            ok(
                f"one budget, still {usdc(still['daily_cap_units'])} a day — "
                "asking twice did not widen it"
            )
            ok("this is the repeatable beat — it needs no new human to demonstrate")
        else:
            bad(f"the second attempt left the budget changed: {still}")


def leg_policy_gate(rig, key) -> None:
    """Changing the RULES, which should not be clearable by whatever cleared a payment.

    The vault supports this directly: `requirePolicyCheckpoint` gates
    `setPolicy`, `setAgent` and `allowSeller` over a hash it derives ITSELF
    rather than one the caller supplies -- which is the audit finding F1, and
    the reason a stolen signature for "scout's cap becomes 77 USDC" cannot be
    replayed against a different call.

    WHAT THIS LEG DOES NOT CLAIM. Our shipped default for the policy path is
    `orb-face, orb`, which ACCEPTS a plain orb token: it is a superset of the
    spend path's list, not a stronger one. That default is deliberate -- a
    deployment whose treasurer has no face credential would otherwise be unable
    to change its own rules ever again -- but it means the honest description
    of the default is "a second, independent, fresh verification", not "a
    stronger class". So this leg configures the policy validator to orb-face
    ALONE, which is the configuration that makes the separation real, and shows
    both halves: the weaker token refused, the stronger one accepted.
    """
    step("11 \u00b7 a POLICY change, held to a class a payment is not")
    c, w3, v = rig["client"], rig["w3"], rig["vault"]
    owner = rig["acct"]["owner"]
    zero = b"\x00" * 32

    send(w3, owner, v.functions.setPolicyCheckpointRequired(True, 0, 0, zero, zero))
    if v.functions.requirePolicyCheckpoint().call():
        ok("policy checkpoints now required \u00b7 turning this gate back OFF needs a human too")
    else:
        bad("setPolicyCheckpointRequired(True) did not take")
        return

    #: Widen the human-approved band from 10% to 12%. Exactly the kind of
    #: change a treasurer should not be able to make unattended.
    wider = (100, 1200, 3600, 1500, 1000, 3000, 48, 25_000_000)
    policy_hash = bytes(v.functions.policyApprovalHash(wider).call())
    ok(f"the chain derives the approval hash itself: {policy_hash.hex()[:18]}\u2026")

    #: SIMULATED first, deliberately. `send()` passes an explicit gas limit, so
    #: there is no pre-flight estimate and an unapproved call mines with status
    #: 0 -- refused, but with the vault's own sentence nowhere to be found. A
    #: `.call()` is the only way to read the reason, and a reason is what this
    #: script exists to print.
    try:
        v.functions.setPolicy(wider, b"\x33" * 32, 0, 0, zero, zero).call({"from": owner.address})
        bad("an unapproved policy change simulated CLEANLY, so the gate is not holding")
        return
    except Exception as exc:
        ok(f"unapproved policy change refused on chain: {revert_reason(exc)}")
    #: And then actually send it, because a simulation that refuses while the
    #: real call succeeds is the exact shape of a gate that fails open.
    try:
        send(w3, owner, v.functions.setPolicy(wider, b"\x33" * 32, 0, 0, zero, zero))
        bad("the owner changed policy with NO human approval")
        return
    except Exception:
        ok("and the sent transaction fails too, so the gate is not merely advisory")

    parked = c.open_checkpoint(
        agent_id=AGENT_ID, req_hash=policy_hash, kind=KIND_POLICY, ttl_s=TTL_S
    )
    cp = c.checkpoint_of(parked["id"])
    if cp.kind == KIND_POLICY:
        ok(
            f"checkpoint #{parked['id']} open, kind POLICY not SPEND \u00b7 tx {parked['tx'][:18]}\u2026"
        )
    else:
        bad(f"checkpoint kind {cp.kind}, expected POLICY ({KIND_POLICY})")

    opened = time.time()
    weak = mint_token(key, synth_claims(acr=ORB, now=opened))
    verdict = validate(rig, key, weak, opened_at=opened, accepted=(ORB_FACE,))
    if verdict.refused and verdict.reason == "assurance_not_accepted":
        ok("the token that cleared the PAYMENT is refused here: assurance_not_accepted")
    else:
        bad(f"a plain orb token was accepted for a policy change: {verdict.reason}")

    strong = mint_token(key, synth_claims(acr=ORB_FACE, now=opened))
    verdict = validate(rig, key, strong, opened_at=opened, accepted=(ORB_FACE,))
    if verdict.refused:
        bad(f"the face token was refused for a policy change: {verdict.reason}")
        return
    ok(f"a face verification is accepted \u00b7 acr {verdict.claims.acr.rsplit('/', 1)[-1]}")

    sv, sr, ss = c.sign_approval(
        cp_id=parked["id"], req_hash=policy_hash, expires_at=cp.expires_at, signer=rig["approver"]
    )
    before = v.functions.policy().call()[1]
    send(w3, owner, v.functions.setPolicy(wider, b"\x33" * 32, parked["id"], sv, sr, ss))
    after = v.functions.policy().call()[1]
    if after == 1200 and before == 1000:
        ok(
            f"human-approved band {before / 100:.0f}% -> {after / 100:.0f}% on chain, once a person said so"
        )
    else:
        bad(f"the band read {before} then {after}, expected 1000 then 1200")
    if c.checkpoint_of(parked["id"]).status == 1:
        ok("the policy checkpoint is CONSUMED, so that approval cannot widen the band again")
    else:
        bad("the policy checkpoint did not consume")


# --- the live issuer --------------------------------------------------------


def leg_live_device_flow(rig) -> None:
    """The same legs, but the human is real and holding a phone.

    Everything above runs identically; only the token's provenance changes. If
    this refuses, the reason is the thing to read out loud -- `access_denied`
    here means refused, assurance unmet, or a different human, and the provider
    cannot tell us which.
    """
    step("5L · the LIVE issuer — a real human, a real phone")
    from index_api.worldflow import DeviceFlow  # noqa: F401

    iss = os.environ.get("ACR_WORLD_OIDC_ISSUER", "")
    cid = os.environ.get("ACR_WORLD_OIDC_CLIENT_ID", "")
    if not iss or not cid:
        bad("REHEARSE_WORLD=live but ACR_WORLD_OIDC_ISSUER/CLIENT_ID are unset -- nothing to ask")
        return
    note(f"issuer {iss} · client {cid[:8]}…")
    note("run `make world-probe` first: it answers whether this issuer will")
    note("issue to this account at a class we accept, in about 20 seconds.")
    bad("the live leg is driven by `make world-probe` / `make world-enroll`, not from here")


# --- the verdict ------------------------------------------------------------


def main() -> int:
    print(f"ACR Float · World ID rehearsal · {time.strftime('%Y-%m-%d %H:%M')}")
    print(f"  node    {RPC}")
    print(f"  human   {WORLD}")
    print(f"  strict  {'on' if STRICT else 'off'}")

    missing = [str(p.relative_to(ROOT)) for p in _ARTS.values() if not p.exists()]
    if missing:
        bad(f"contracts not built: {', '.join(missing)} -- run: cd contracts && forge build")
        return 1

    step("0 · the node, before a key is loaded")
    w3 = connect()
    if w3 is None:
        return 1

    t0 = time.time()
    rig = stand_up(w3)
    timings.append(("stand up a fresh vault, wired and funded", time.time() - t0))
    ok(f"vault {rig['vault'].address} deployed and wired in {timings[-1][1]:.1f}s")

    leg_wiring(rig)
    opening = leg_agent_holds_nothing(rig, "before anything")
    leg_in_policy(rig)

    if WORLD == "live":
        leg_live_device_flow(rig)
    else:
        key = synth_keypair()
        t = time.time()
        parked = leg_park(rig, nonce=b"\x30" * 32, label="the one a human will clear")
        if parked:
            leg_approve(rig, parked, key)
        timings.append(("park, verify a human, release the payment", time.time() - t))

        t = time.time()
        leg_denied(rig, key)
        timings.append(("park and deny", time.time() - t))
        t = time.time()
        leg_expired(rig)
        timings.append(("park and let the window close", time.time() - t))
        t = time.time()
        leg_wrong_human(rig, key)
        timings.append(("three refusals that are not the human's fault", time.time() - t))
        leg_agent_mismatch(rig)
        t = time.time()
        leg_guest(rig)
        timings.append(("a visitor joins and gets a guest budget", time.time() - t))
        t = time.time()
        leg_policy_gate(rig, key)
        timings.append(("change the rules, held to a stronger class", time.time() - t))

    closing = leg_agent_holds_nothing(rig, "after everything")
    if opening == closing == 0:
        ok("the agent's wallet held nothing at the start and nothing at the end")

    step("timings — these are the numbers the debrief's table wants")
    for label, secs in timings:
        print(f"  {secs:6.1f}s  {label}")

    print("\n" + "-" * 72)
    if notes:
        print(f"{len(notes)} thing(s) worth knowing:")
        for n in notes:
            print(f"  · {n}")
    if fails:
        print(f"\n✗ {len(fails)} step(s) WOULD NOT SURVIVE THE DEMO:")
        for f in fails:
            print(f"    {f}")
    else:
        print("✓ every leg of the World journey ran, with real values on screen")
        if WORLD != "live":
            print("  the human was synthetic; the validation of them was not.")
            print("  -> REHEARSE_WORLD=live with a registered client for the real one")
    return 1 if fails and STRICT else 0


if __name__ == "__main__":
    sys.exit(main())
