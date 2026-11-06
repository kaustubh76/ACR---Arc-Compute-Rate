"""The human checkpoint, end to end, against the real FloatVault on anvil.

Two equalities here cannot be proved any other way, and everything else in the
World track is downstream of them:

  * our `abi.encode` of `SpendReq` must be the vault's `hashSpendReq`
  * our EIP-712 digest must be the vault's `approvalDigest`

A mock vault could not prove either, because a mock would carry a second copy
of the same assumptions. So this deploys the committed contract.

Port discipline: a foreign anvil on 8545 once ran a whole suite against another
chain with no error at all, and both anvils report chain id 31337, so the port
is the only thing that distinguishes them. Default here is **8546**, this file
never starts or kills a node, and with nothing listening it skips.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from acr_oracle_client.float_vault import (
    CONSUMED,
    KIND_SPEND,
    OPEN,
    FloatVaultClient,
    SpendReq,
    hash_spend_req,
)
from acr_oracle_client.signer import LocalKeySigner

RPC = os.environ.get("ACR_TEST_RPC", "http://127.0.0.1:8546")
_OUT = Path(__file__).resolve().parents[3] / "contracts/out"
_ARTS = {
    "vault": _OUT / "FloatVault.sol/FloatVault.json",
    "usdc": _OUT / "MockUSDC.sol/MockUSDC.json",
    "prices": _OUT / "FloatPrintStore.sol/FloatPrintStore.json",
}

pytestmark = pytest.mark.skipif(
    not all(p.exists() for p in _ARTS.values()),
    reason="contracts not built (run: cd contracts && forge build)",
)

#: anvil's deterministic accounts. Deliberately one key per role, because the
#: vault now refuses `approver is an executor` and a shared key would hide it.
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
GUEST_CAP = 2_000_000


def _anvil():
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 5}))
    if not w3.is_connected():
        return None
    return w3


def _deploy(w3, art: Path, owner, *args):
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
    rcpt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
    assert rcpt.status == 1, f"deploying {art.stem} reverted"
    return w3.eth.contract(address=rcpt.contractAddress, abi=a["abi"])


def _send(w3, acct, fn):
    tx = fn.build_transaction(
        {
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": 3_000_000,
        }
    )
    signed = w3.eth.account.sign_transaction(tx, acct.key)
    rcpt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
    assert rcpt.status == 1, "transaction reverted"
    return rcpt


def _build_rig(w3, *, binding: bytes | None):
    """A wired vault. `binding=None` leaves `treasurerBinding` at zero.

    Parameterised rather than copied because `setTreasurerBinding` is one-shot
    from zero: an unbound vault cannot be the shared rig with a setter called
    later, it has to be its own deployment.
    """
    acct = {k: w3.eth.account.from_key(v) for k, v in KEYS.items()}
    owner = acct["owner"]

    usdc = _deploy(w3, _ARTS["usdc"], owner)
    prices = _deploy(w3, _ARTS["prices"], owner)
    vault = _deploy(w3, _ARTS["vault"], owner, usdc.address, prices.address, GUEST_CAP)

    _send(w3, owner, prices.functions.setSigner(owner.address, True))
    #: A price per unit in WAD. The exact number does not matter: every fair
    #: value below is read back from the vault's own `classify`, never computed
    #: here, so this test cannot drift from their arithmetic.
    _send(w3, owner, prices.functions.setPrint(INDEX, 3_000_000_000_000_000, 250))

    _send(
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
    _send(
        w3, owner, vault.functions.setPolicy(policy, b"\x11" * 32, 0, 0, b"\x00" * 32, b"\x00" * 32)
    )
    #: perRequest deliberately tiny so an ordinary quote escalates; the daily
    #: cap is wide so it is the THRESHOLD being tested, not the cap.
    _send(
        w3,
        owner,
        vault.functions.setAgent(
            AGENT_ID, 500_000_000, 1_000_000, False, b"\x22" * 32, 0, 0, b"\x00" * 32, b"\x00" * 32
        ),
    )
    _send(
        w3,
        owner,
        vault.functions.allowSeller(
            AGENT_ID, acct["seller"].address, True, 0, 0, b"\x00" * 32, b"\x00" * 32
        ),
    )
    _send(w3, owner, usdc.functions.mint(vault.address, 1_000_000_000))
    if binding is not None:
        _send(w3, owner, vault.functions.setTreasurerBinding(binding))

    client = FloatVaultClient(w3, vault.address, signer=LocalKeySigner(KEYS["executor"]))
    return {
        "w3": w3,
        "acct": acct,
        "usdc": usdc,
        "prices": prices,
        "vault": vault,
        "client": client,
        "approver": LocalKeySigner(KEYS["approver"]),
    }


def _w3_or_skip():
    w3 = _anvil()
    if w3 is None:
        pytest.skip(f"no anvil at {RPC} (start one with: anvil --port 8546)")
    return w3


@pytest.fixture(scope="module")
def rig():
    return _build_rig(_w3_or_skip(), binding=b"\x42" * 32)


@pytest.fixture(scope="module")
def unbound_rig():
    """A vault whose `treasurerBinding` was never set, for the one disclosure
    test that needs that state and cannot reach it by un-setting."""
    return _build_rig(_w3_or_skip(), binding=None)


def _req(rig, *, quote: int, nonce: bytes) -> SpendReq:
    return SpendReq(
        agent_id=AGENT_ID,
        seller=rig["acct"]["seller"].address,
        index=INDEX,
        units=6000,
        quote_total=quote,
        print_id=1,
        nonce=nonce,
    )


def _fair(rig) -> int:
    """Ask the chain what fair is, rather than reimplementing their maths."""
    probe = rig["client"].classify(_req(rig, quote=1, nonce=b"\xaa" * 32))
    assert probe["fair_usdc"] > 0, probe
    return probe["fair_usdc"]


# --- the two equalities -----------------------------------------------------


def test_our_spend_request_encoding_is_the_vaults_hash(rig):
    req = _req(rig, quote=18_000_000, nonce=b"\x01" * 32)
    assert hash_spend_req(req) == rig["client"].hash_spend_req_onchain(req)
    #: req_hash() is the guarded accessor: it refuses rather than returning a
    #: hash the chain would disagree with.
    assert rig["client"].req_hash(req) == hash_spend_req(req)


def test_a_changed_field_changes_the_hash(rig):
    a = _req(rig, quote=18_000_000, nonce=b"\x01" * 32)
    b = _req(rig, quote=18_000_001, nonce=b"\x01" * 32)
    assert rig["client"].req_hash(a) != rig["client"].req_hash(b)


def test_our_approval_digest_is_the_vaults_approval_digest(rig):
    from acr_oracle_client.float_vault import approval_digest

    c = rig["client"]
    local = approval_digest(
        c.chain_id,
        c.address,
        cp_id=7,
        req_hash=b"\x33" * 32,
        expires_at=1_800_000_000,
        binding=b"\x42" * 32,
    )
    chain = bytes(
        rig["vault"].functions.approvalDigest(7, b"\x33" * 32, 1_800_000_000, b"\x42" * 32).call()
    )
    assert local == chain


def test_the_primary_type_name_is_load_bearing(rig):
    """Signing `Approval` instead of `FloatApproval` must NOT match.

    The playbook this feature came from specifies `Approval(...)`. The contract
    uses `FloatApproval(...)`. Both produce a perfectly valid signature; only
    one recovers to the approver, and `ecrecover` reports the difference as a
    stranger's address rather than as a type error.
    """
    from acr_oracle_client.float_vault import domain
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak

    c = rig["client"]
    wrong_types = {
        "Approval": [
            {"name": "id", "type": "uint256"},
            {"name": "reqHash", "type": "bytes32"},
            {"name": "expiresAt", "type": "uint64"},
            {"name": "humanBinding", "type": "bytes32"},
        ]
    }
    msg = {
        "id": 7,
        "reqHash": b"\x33" * 32,
        "expiresAt": 1_800_000_000,
        "humanBinding": b"\x42" * 32,
    }
    signable = encode_typed_data(
        domain_data=domain(c.chain_id, c.address), message_types=wrong_types, message_data=msg
    )
    wrong = bytes(keccak(b"\x19" + signable.version + signable.header + signable.body))
    right = bytes(
        rig["vault"].functions.approvalDigest(7, b"\x33" * 32, 1_800_000_000, b"\x42" * 32).call()
    )
    assert wrong != right


# --- the ladder says it is an escalation -----------------------------------


def test_an_over_threshold_quote_classifies_as_an_escalation_not_a_refusal(rig):
    fair = _fair(rig)
    out = rig["client"].classify(_req(rig, quote=fair, nonce=b"\x04" * 32))
    #: D_PER_REQUEST == 11. It is the one code the vault leaves re-executable,
    #: because it is the escalation, not a refusal.
    assert out["code"] == 11, out
    assert out["reason"] == "over per-request threshold"


def test_a_quote_above_the_human_band_is_refused_outright(rig):
    fair = _fair(rig)
    out = rig["client"].classify(_req(rig, quote=fair * 3, nonce=b"\x05" * 32))
    assert out["reason"] == "quote exceeds ACR fair band"


# --- park, approve, pay -----------------------------------------------------


def test_a_parked_spend_pays_once_and_the_agent_never_holds_a_cent(rig):
    c = rig["client"]
    fair = _fair(rig)
    #: 3% over fair: above the agent's own 1% band, inside the human 10% band.
    #: An approval widens the band; it never removes it.
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x06" * 32)
    seller = rig["acct"]["seller"].address
    agent_eoa = rig["acct"]["agent"].address

    before = rig["usdc"].functions.balanceOf(seller).call()
    assert rig["usdc"].functions.balanceOf(agent_eoa).call() == 0

    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(req), ttl_s=300)
    assert parked["id"] >= 0
    assert c.checkpoint_of(parked["id"]).status == OPEN
    assert c.checkpoint_of(parked["id"]).exists

    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=parked["req_hash"],
        expires_at=parked["expires_at"],
        signer=rig["approver"],
    )
    c.execute_approved(cp_id=parked["id"], req=req, v=v, r=r, s=s)

    assert rig["usdc"].functions.balanceOf(seller).call() == before + req.quote_total
    assert c.checkpoint_of(parked["id"]).status == CONSUMED
    #: The invariant the whole product rests on, held across the payment.
    assert rig["usdc"].functions.balanceOf(agent_eoa).call() == 0


def test_a_replayed_approval_is_refused_by_the_chain(rig):
    c = rig["client"]
    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x07" * 32)
    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(req), ttl_s=300)
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=parked["req_hash"],
        expires_at=parked["expires_at"],
        signer=rig["approver"],
    )
    c.execute_approved(cp_id=parked["id"], req=req, v=v, r=r, s=s)
    with pytest.raises(Exception, match="checkpoint closed"):
        c.execute_approved(cp_id=parked["id"], req=req, v=v, r=r, s=s)


def test_an_approval_cannot_be_lifted_onto_another_payment(rig):
    """The signature covers the request hash, so re-aiming it must fail."""
    c = rig["client"]
    fair = _fair(rig)
    cheap = _req(rig, quote=fair * 103 // 100, nonce=b"\x08" * 32)
    dear = _req(rig, quote=fair * 109 // 100, nonce=b"\x09" * 32)
    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(cheap), ttl_s=300)
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=parked["req_hash"],
        expires_at=parked["expires_at"],
        signer=rig["approver"],
    )
    with pytest.raises(Exception, match="request changed"):
        c.execute_approved(cp_id=parked["id"], req=dear, v=v, r=r, s=s)


def test_a_signature_from_the_wrong_key_moves_nothing(rig):
    c = rig["client"]
    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x0a" * 32)
    seller = rig["acct"]["seller"].address
    before = rig["usdc"].functions.balanceOf(seller).call()
    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(req), ttl_s=300)
    impostor = LocalKeySigner(KEYS["registrar"])
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=parked["req_hash"],
        expires_at=parked["expires_at"],
        signer=impostor,
    )
    with pytest.raises(Exception, match="bad approval"):
        c.execute_approved(cp_id=parked["id"], req=req, v=v, r=r, s=s)
    assert rig["usdc"].functions.balanceOf(seller).call() == before


def test_an_expired_checkpoint_moves_nothing(rig):
    c, w3 = rig["client"], rig["w3"]
    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x0b" * 32)
    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(req), ttl_s=2)
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=parked["req_hash"],
        expires_at=parked["expires_at"],
        signer=rig["approver"],
    )
    #: The TTL is measured on CHAIN time, so the chain's clock is what moves.
    w3.provider.make_request("evm_increaseTime", [10])
    w3.provider.make_request("evm_mine", [])
    with pytest.raises(Exception, match="checkpoint expired"):
        c.execute_approved(cp_id=parked["id"], req=req, v=v, r=r, s=s)


def test_a_fabricated_checkpoint_id_is_refused(rig):
    """Status 0 IS "open", so an id nobody opened reads as an open checkpoint."""
    c = rig["client"]
    never = c.checkpoint_of(99_999)
    assert never.status == OPEN
    assert not never.exists
    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x0c" * 32)
    v, r, s = c.sign_approval(
        cp_id=99_999,
        req_hash=c.req_hash(req),
        expires_at=int(time.time()) + 300,
        signer=rig["approver"],
    )
    #: It IS refused, but not by the guard that names the real problem.
    #: `executeApproved` compares `checkpoints[id].agentId` to the request's
    #: BEFORE `_consumeApproval` reaches `require(c.reqHash != 0)`, and an
    #: id nobody opened has a zero agentId -- so a bad id reports as an agent
    #: derivation bug. Nothing moves either way; the cost is a debugger sent
    #: hunting the wrong thing. Reported to the contract owner: the existence
    #: check wants to sit above the comparison. Pinned to the real message so
    #: that reordering shows up here as a failure rather than passing quietly.
    with pytest.raises(Exception, match="agent mismatch"):
        c.execute_approved(cp_id=99_999, req=req, v=v, r=r, s=s)


def test_a_real_checkpoint_executed_for_another_agent_is_refused(rig):
    """The agentId the chain stored is the one the request must carry.

    The vault used to announce an agentId in `CheckpointOpened` that it never
    stored, so an executor could park a checkpoint naming one agent whose hash
    committed to another: the public record said a human approved X while X was
    never what moved. The vault now stores it and compares. This drives that
    comparison from the signer's side, which is the half the contract's own
    tests cannot reach -- a mismatch here means our client re-derived an
    agentId instead of carrying the chain's.
    """
    c = rig["client"]
    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x0e" * 32)
    parked = c.open_checkpoint(
        agent_id=req.agent_id, req_hash=c.req_hash(req), kind=KIND_SPEND, ttl_s=300
    )
    #: The chain hands back what it stored, so the two can be compared rather
    #: than assumed equal.
    assert parked["agent_id"] == req.agent_id
    assert c.checkpoint_of(parked["id"]).agent_id == req.agent_id

    other = SpendReq(
        agent_id=b"waster".ljust(32, b"\x00"),
        seller=req.seller,
        index=req.index,
        units=req.units,
        quote_total=req.quote_total,
        print_id=req.print_id,
        nonce=b"\x0f" * 32,
    )
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=c.req_hash(other),
        expires_at=int(time.time()) + 300,
        signer=rig["approver"],
    )
    with pytest.raises(Exception, match="agent mismatch"):
        c.execute_approved(cp_id=parked["id"], req=other, v=v, r=r, s=s)

    #: Refused, and the checkpoint is still open for the agent it was parked
    #: for -- the whole transaction rolled back.
    assert c.checkpoint_of(parked["id"]).status == OPEN


# --- an unsuccessful escalation is evidence --------------------------------


def test_a_denial_is_recorded_on_chain_and_moves_nothing(rig):
    c = rig["client"]
    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x0d" * 32)
    seller = rig["acct"]["seller"].address
    before = rig["usdc"].functions.balanceOf(seller).call()
    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(req), ttl_s=300)
    c.resolve_checkpoint(cp_id=parked["id"], outcome="denied", reason="the treasurer declined")
    #: DENIED == 2. The refusal is public, which is the point: an unsuccessful
    #: escalation is evidence, not silence.
    assert c.checkpoint_of(parked["id"]).status == 2
    assert rig["usdc"].functions.balanceOf(seller).call() == before
    with pytest.raises(Exception, match="checkpoint closed"):
        c.resolve_checkpoint(cp_id=parked["id"], outcome="failed", reason="twice")


def test_an_unknown_outcome_never_reaches_the_chain(rig):
    with pytest.raises(ValueError, match="outcome must be one of"):
        rig["client"].resolve_checkpoint(cp_id=1, outcome="approved", reason="no")


# --- preflight --------------------------------------------------------------


def test_the_status_check_notices_an_address_with_no_contract(rig):
    #: An address with no code neither reverts nor fails gas estimation; it
    #: returns a transaction hash for a payment that moved nothing.
    empty = FloatVaultClient(rig["w3"], "0x" + "ab" * 20, signer=rig["client"].signer)
    assert empty.vault_status() == "no contract code at the vault address on this chain"


def test_the_status_check_passes_on_a_wired_vault(rig):
    assert rig["client"].vault_status() == "ok"


def test_the_status_check_refuses_an_executor_that_is_not_authorized(rig):
    stranger = FloatVaultClient(
        rig["w3"], rig["vault"].address, signer=LocalKeySigner(KEYS["agent"])
    )
    assert stranger.vault_status() == "our signer is not an authorized executor"


def test_only_an_executor_can_park(rig):
    rogue = FloatVaultClient(rig["w3"], rig["vault"].address, signer=LocalKeySigner(KEYS["agent"]))
    with pytest.raises(Exception, match="not executor"):
        rogue.open_checkpoint(agent_id=AGENT_ID, req_hash=b"\x0e" * 32, ttl_s=300)


def test_the_id_comes_from_the_event_not_the_return_value(rig):
    """A transaction cannot read a return value, so the log is the only source."""
    c = rig["client"]
    first = c.open_checkpoint(agent_id=AGENT_ID, req_hash=b"\x21" * 32, ttl_s=300)
    second = c.open_checkpoint(agent_id=AGENT_ID, req_hash=b"\x22" * 32, ttl_s=300)
    assert second["id"] == first["id"] + 1
    assert c.checkpoint_of(first["id"]).req_hash == b"\x21" * 32
    assert c.checkpoint_of(second["id"]).kind == KIND_SPEND


def test_an_unset_binding_leaves_the_human_half_of_an_approval_vacuous(unbound_rig):
    """A DISCLOSURE, not a feature: the chain never requires a binding.

    `_consumeApproval` feeds `treasurerBinding` into the digest whatever it
    holds (`FloatVault.sol:943`) and guards only the APPROVER against zero
    (`:942` and `:944`, because `ecrecover` returns address(0) on a malformed
    signature). A binding of zero is a perfectly valid signature target that
    identifies NOBODY, so the approver's signature still authorises the payment
    while attesting to no human at all.

    Nothing an attacker reaches -- it needs the approver's key, and the approver
    cannot invent a request. What it means is that "a verified human cleared
    this" is enforced OFF chain: `vault_status()` refuses exactly this state and
    `floatgate` will not park into it. This test exists so that division of
    labour is written down, because the public vault's binding is zero right
    now and the order in which the two roles are set therefore matters.

    Asked because a peer asked the right question of a one-shot field: not
    whether the value is right, but whether any READER silently accepts a zero.
    """
    rig = unbound_rig
    c = rig["client"]
    assert c.treasurer_binding() == b"\x00" * 32

    #: The off-chain guard IS the protection, so prove it is awake first.
    status = c.vault_status()
    assert "bind to nobody" in status, status

    fair = _fair(rig)
    req = _req(rig, quote=fair * 103 // 100, nonce=b"\x51" * 32)
    seller = rig["acct"]["seller"].address
    before = rig["usdc"].functions.balanceOf(seller).call()

    parked = c.open_checkpoint(agent_id=AGENT_ID, req_hash=c.req_hash(req), ttl_s=300)
    v, r, s = c.sign_approval(
        cp_id=parked["id"],
        req_hash=parked["req_hash"],
        expires_at=parked["expires_at"],
        signer=rig["approver"],
    )
    c.execute_approved(cp_id=parked["id"], req=req, v=v, r=r, s=s)

    #: And it PAID, over a binding that names nobody. That is the finding.
    assert rig["usdc"].functions.balanceOf(seller).call() == before + req.quote_total
    assert c.checkpoint_of(parked["id"]).status == CONSUMED
