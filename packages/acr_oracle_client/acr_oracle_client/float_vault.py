"""FloatVault — signing and driving the human checkpoint from Python.

Shaped on `feed_access.py`: the ABI, the EIP-712 types and the signing live in
one file, so a struct cannot drift from the thing that hashes it.

TWO WITNESSES, NOT ONE. `feed_access.py` proves a signature recovers to our own
signer before anything broadcasts. This goes one further, because `FloatVault`
exposes its own `approvalDigest` view and says why: "Exposed so a signer checks
itself against the chain's arithmetic rather than a copy of it." So every
approval is checked twice -- the digest we built must equal the digest the
CONTRACT builds, and the signature must recover to us -- and both happen before
a transaction exists. A mismatch is caught as a refusal here rather than as
`"bad approval"` from an `ecrecover` that returns a stranger.

WHAT THE CHAIN CANNOT SEE. `_consumeApproval` feeds the contract-level
`treasurerBinding` into the digest, not a per-checkpoint value. So the chain can
assert only "the enrolled treasurer's identity hashes to this". It cannot see
freshness, the assurance class, or which verification happened -- all of that is
enforced in `index_api.worldauth`. Claim the division precisely: the chain
enforces WHAT was approved and that it is single-use; the server enforces WHO
approved it and THAT THEY DID IT JUST NOW.

AND THE TRAP THAT IS NOT OURS. `requestSpend` burns the request nonce on every
refusal except `D_PER_REQUEST`, which is the escalation code. So the only codes
that can be parked are the ones the contract deliberately leaves re-executable;
a band or cap refusal cannot come back later when a price has moved. Where we
already know we are parking, `classify` is a view and cheaper.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: The vault's own type string:
#: "FloatApproval(uint256 id,bytes32 reqHash,uint64 expiresAt,bytes32 humanBinding)".
#: The primary type is FloatApproval, not Approval -- signing the shorter name
#: produces a valid signature over the wrong struct hash, and `ecrecover` then
#: returns a stranger with no diagnostic.
APPROVAL_TYPES: dict[str, list[dict[str, str]]] = {
    "FloatApproval": [
        {"name": "id", "type": "uint256"},
        {"name": "reqHash", "type": "bytes32"},
        {"name": "expiresAt", "type": "uint64"},
        {"name": "humanBinding", "type": "bytes32"},
    ]
}

DOMAIN_NAME = "ACR Float Vault"
DOMAIN_VERSION = "1"

#: `SpendReq`'s field types, in declaration order. `abi.encode` of an all-static
#: struct is just these seven words concatenated -- but the only proof that our
#: encoding matches theirs is the `hashSpendReq` view, which the onchain test
#: compares against word for word.
SPEND_REQ_TYPES = ("bytes32", "address", "bytes32", "uint256", "uint256", "uint64", "bytes32")

KIND_SPEND = 1
KIND_POLICY = 2

#: Checkpoint status, mirroring the vault's internal constants. OPEN is zero,
#: which is also what an id that was never opened reads as -- the vault guards
#: that with a non-zero `reqHash`, and so does `checkpoint_of` below.
OPEN = 0
CONSUMED = 1
DENIED = 2
EXPIRED = 3
FAILED = 4

#: What our own refusal reasons resolve to on chain. Anything that is not a
#: human saying no and not a lapsed clock is a failure with its reason attached,
#: because an unsuccessful escalation is evidence, not silence.
OUTCOMES: dict[str, int] = {"denied": DENIED, "expired": EXPIRED, "failed": FAILED}

_SPEND_REQ_ABI = {
    "name": "r",
    "type": "tuple",
    "components": [
        {"name": "agentId", "type": "bytes32"},
        {"name": "seller", "type": "address"},
        {"name": "index", "type": "bytes32"},
        {"name": "units", "type": "uint256"},
        {"name": "quoteTotal", "type": "uint256"},
        {"name": "printId", "type": "uint64"},
        {"name": "nonce", "type": "bytes32"},
    ],
}

VAULT_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "hashSpendReq",
        "stateMutability": "pure",
        "inputs": [_SPEND_REQ_ABI],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "approvalDigest",
        "stateMutability": "view",
        "inputs": [
            {"name": "id", "type": "uint256"},
            {"name": "reqHash", "type": "bytes32"},
            {"name": "expiresAt", "type": "uint64"},
            {"name": "binding", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "classify",
        "stateMutability": "view",
        "inputs": [_SPEND_REQ_ABI],
        "outputs": [
            {"name": "reason", "type": "string"},
            {"name": "code", "type": "uint8"},
            {"name": "fairUsdc", "type": "uint256"},
            {"name": "printId", "type": "uint64"},
        ],
    },
    {
        "type": "function",
        "name": "openCheckpoint",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "bytes32"},
            {"name": "reqHash", "type": "bytes32"},
            {"name": "kind", "type": "uint8"},
            {"name": "ttl", "type": "uint64"},
        ],
        "outputs": [{"name": "id", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "resolveCheckpoint",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "id", "type": "uint256"},
            {"name": "outcome", "type": "uint8"},
            {"name": "reason", "type": "string"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "executeApproved",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "id", "type": "uint256"},
            _SPEND_REQ_ABI,
            {"name": "v", "type": "uint8"},
            {"name": "rs", "type": "bytes32"},
            {"name": "ss", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "registerGuest",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "agentId", "type": "bytes32"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "checkpoints",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [
            {"name": "reqHash", "type": "bytes32"},
            {"name": "expiresAt", "type": "uint64"},
            {"name": "kind", "type": "uint8"},
            {"name": "status", "type": "uint8"},
            #: Added by the vault's own audit fix: the agentId is now STORED,
            #: not merely announced, and `executeApproved` compares the request
            #: against it. Decoding four words from a five-word return read the
            #: right four and silently dropped the one the comparison uses.
            {"name": "agentId", "type": "bytes32"},
        ],
    },
    {
        "type": "function",
        "name": "nextCheckpointId",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "treasurerBinding",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function",
        "name": "humanApprover",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "guestRegistrar",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "isExecutor",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "paused",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "guestDailyCap",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "agentOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "bytes32"}],
        "outputs": [
            {"name": "exists", "type": "bool"},
            {"name": "dailyCapUsdc", "type": "uint256"},
            {"name": "spent", "type": "uint256"},
            {"name": "perRequestUsdc", "type": "uint256"},
            {"name": "periodStart", "type": "uint64"},
            {"name": "frozen", "type": "bool"},
            {"name": "guest", "type": "bool"},
        ],
    },
    {
        "type": "function",
        "name": "totalValueUsdc",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "event",
        "name": "GuestRegistered",
        "anonymous": False,
        "inputs": [
            {"name": "agentId", "type": "bytes32", "indexed": True},
            {"name": "dailyCap", "type": "uint256", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "CheckpointOpened",
        "anonymous": False,
        "inputs": [
            {"name": "id", "type": "uint256", "indexed": True},
            {"name": "agentId", "type": "bytes32", "indexed": True},
            {"name": "reqHash", "type": "bytes32", "indexed": False},
            {"name": "kind", "type": "uint8", "indexed": False},
            {"name": "expiresAt", "type": "uint64", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "CheckpointResolved",
        "anonymous": False,
        "inputs": [
            {"name": "id", "type": "uint256", "indexed": True},
            {"name": "outcome", "type": "uint8", "indexed": True},
            {"name": "reason", "type": "string", "indexed": False},
        ],
    },
]


@dataclass(frozen=True)
class SpendReq:
    """The request the vault hashes. Field order is load-bearing."""

    agent_id: bytes
    seller: str
    index: bytes
    units: int
    quote_total: int
    print_id: int
    nonce: bytes

    def as_tuple(self) -> tuple:
        from eth_utils import to_checksum_address

        return (
            _b32(self.agent_id),
            to_checksum_address(self.seller),
            _b32(self.index),
            int(self.units),
            int(self.quote_total),
            int(self.print_id),
            _b32(self.nonce),
        )


@dataclass(frozen=True)
class Checkpoint:
    id: int
    req_hash: bytes
    expires_at: int
    kind: int
    status: int
    #: The agent the CHAIN committed to when the checkpoint opened. Carried so
    #: the executor can send the request the human actually approved rather
    #: than one it re-derived; the vault refuses the difference as
    #: "agent mismatch".
    agent_id: bytes = b"\x00" * 32

    @property
    def exists(self) -> bool:
        #: Status 0 IS "open", so an id that was never opened reads as an open
        #: checkpoint. A non-zero request hash is the only proof it is real --
        #: `openCheckpoint` rejects a zero hash precisely so this works.
        return self.req_hash != b"\x00" * 32


def _b32(raw: bytes | str) -> bytes:
    if isinstance(raw, str):
        from eth_utils import to_bytes

        raw = to_bytes(hexstr=raw) if raw.startswith("0x") else raw.encode()
    if len(raw) != 32:
        raise ValueError(f"expected a 32-byte word, got {len(raw)} bytes")
    return bytes(raw)


def domain(chain_id: int, vault: str) -> dict[str, Any]:
    from eth_utils import to_checksum_address

    return {
        "name": DOMAIN_NAME,
        "version": DOMAIN_VERSION,
        "chainId": int(chain_id),
        "verifyingContract": to_checksum_address(vault),
    }


def hash_spend_req(req: SpendReq) -> bytes:
    """`keccak256(abi.encode(r))`, computed locally.

    Only ever used as the thing the chain's own `hashSpendReq` is checked
    against: a hash we are confident about and the contract disagrees with is
    the drift this function exists to surface.
    """
    from eth_abi import encode as abi_encode
    from eth_utils import keccak

    return bytes(keccak(abi_encode(list(SPEND_REQ_TYPES), list(req.as_tuple()))))


def approval_digest(
    chain_id: int, vault: str, *, cp_id: int, req_hash: bytes, expires_at: int, binding: bytes
) -> bytes:
    """The EIP-712 digest, built locally the way `agentcard.py` builds one."""
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak

    signable = encode_typed_data(
        domain_data=domain(chain_id, vault),
        message_types=APPROVAL_TYPES,
        message_data={
            "id": int(cp_id),
            "reqHash": _b32(req_hash),
            "expiresAt": int(expires_at),
            "humanBinding": _b32(binding),
        },
    )
    return bytes(keccak(b"\x19" + signable.version + signable.header + signable.body))


class FloatVaultClient:
    """Reads and writes one deployed FloatVault."""

    def __init__(self, w3, vault: str, *, signer=None) -> None:
        from eth_utils import to_checksum_address

        self.w3 = w3
        self.address = to_checksum_address(vault)
        self.signer = signer
        self.contract = w3.eth.contract(address=self.address, abi=VAULT_ABI)
        self.chain_id = int(w3.eth.chain_id)

    # --- reads ------------------------------------------------------------

    def hash_spend_req_onchain(self, req: SpendReq) -> bytes:
        return bytes(self.contract.functions.hashSpendReq(req.as_tuple()).call())

    def req_hash(self, req: SpendReq) -> bytes:
        """The hash to park under, agreed by both sides or refused."""
        local, chain = hash_spend_req(req), self.hash_spend_req_onchain(req)
        if local != chain:
            raise RuntimeError(
                "our SpendReq encoding does not match the vault's hashSpendReq -- refusing "
                f"(ours {local.hex()}, chain {chain.hex()})"
            )
        return chain

    def classify(self, req: SpendReq) -> dict:
        reason, code, fair, print_id = self.contract.functions.classify(req.as_tuple()).call()
        return {
            "reason": reason,
            "code": int(code),
            "fair_usdc": int(fair),
            "print_id": int(print_id),
        }

    def checkpoint_of(self, cp_id: int) -> Checkpoint:
        req_hash, expires_at, kind, status, agent_id = self.contract.functions.checkpoints(
            int(cp_id)
        ).call()
        return Checkpoint(
            int(cp_id),
            bytes(req_hash),
            int(expires_at),
            int(kind),
            int(status),
            bytes(agent_id),
        )

    def treasurer_binding(self) -> bytes:
        return bytes(self.contract.functions.treasurerBinding().call())

    def human_approver(self) -> str:
        """The one key the vault will accept an approval from.

        Read, never assumed. `wire()` points every role at the deployer, and a
        press is configured afterwards with its own keys -- so the two drift
        apart with nothing to announce it. Measured on the public deploy
        2026-11-06: the chain held the deployer while the press held three
        separate role keys, and all three disagreed.
        """
        return str(self.contract.functions.humanApprover().call())

    def agent_of(self, agent_id: bytes) -> dict:
        """One agent's standing. `exists` is the whole answer to "already issued".

        Two things that look identical and are not: an agent nobody registered
        reads `exists == False`, and so does a DIFFERENT vault with a
        compatible ABI, which decodes a zero tuple quietly rather than raising.
        `guest_preflight` is what tells those apart, and it runs first.
        """
        exists, daily, spent, per_req, period_start, frozen, guest = (
            self.contract.functions.agentOf(_b32(agent_id)).call()
        )
        return {
            "exists": bool(exists),
            "daily_cap_units": int(daily),
            "spent_units": int(spent),
            "per_request_units": int(per_req),
            "period_start": int(period_start),
            "frozen": bool(frozen),
            "guest": bool(guest),
        }

    def guest_daily_cap(self) -> int:
        return int(self.contract.functions.guestDailyCap().call())

    def guest_registrar(self) -> str:
        return str(self.contract.functions.guestRegistrar().call())

    def total_value_usdc(self) -> int:
        """Buffer plus both sleeves, in units: the treasury's own free float."""
        return int(self.contract.functions.totalValueUsdc().call())

    def guest_preflight(self) -> str:
        """A named refusal, or "ok", before any guest budget is issued.

        The two reads here are cheap and they separate "this human has no
        budget" from "this is not the vault we think it is" -- a distinction
        `agent_of` cannot make on its own, because a stranger contract with a
        compatible ABI answers `exists == False` to everything.
        """
        if not self.w3.eth.get_code(self.address):
            return "no contract code at the vault address on this chain"
        if self.guest_daily_cap() == 0:
            return "this vault issues no guest budget, so it is not the one we mean"
        if self.signer is None:
            return "issuing a guest budget needs a signer"
        registrar = self.guest_registrar()
        if registrar.lower() != self.signer.address.lower():
            #: Otherwise the first sign of it is `registerGuest` reverting
            #: "not registrar" AFTER a claim line is already on disk.
            return f"our signer is not the vault's guest registrar (it is {registrar[:10]}…)"
        return "ok"

    def vault_status(self) -> str:
        """A named refusal, or "ok". Every rung is a thing that silently breaks.

        Checked eagerly because the alternative is finding out mid-demo: a
        vault with no code at the address neither reverts nor fails gas
        estimation, it returns a transaction hash for a payment that moved
        nothing.
        """
        if not self.w3.eth.get_code(self.address):
            return "no contract code at the vault address on this chain"
        if self.contract.functions.paused().call():
            return "the treasury is paused"
        approver = self.human_approver()
        if int(approver, 16) == 0:
            return "the vault has no human approver set"
        if self.signer is not None:
            if not self.contract.functions.isExecutor(self.signer.address).call():
                return "our signer is not an authorized executor"
            if self.signer.address.lower() == approver.lower():
                return "our executor is also the approver, which would let one key approve itself"
        if self.treasurer_binding() == b"\x00" * 32:
            #: A zero binding is a VALID signature target that identifies
            #: nobody, so the human path would pass while binding to no one.
            return "the treasurer binding is unset, so an approval would bind to nobody"
        return "ok"

    # --- the approval -----------------------------------------------------

    def sign_approval(
        self,
        *,
        cp_id: int,
        req_hash: bytes,
        expires_at: int,
        binding: bytes | None = None,
        signer=None,
    ) -> tuple[int, bytes, bytes]:
        """Sign, then prove it twice before anything can broadcast it."""
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        who = signer or self.signer
        if who is None:
            raise RuntimeError("signing an approval needs a signer")
        bind = self.treasurer_binding() if binding is None else _b32(binding)
        dom = domain(self.chain_id, self.address)
        message = {
            "id": int(cp_id),
            "reqHash": _b32(req_hash),
            "expiresAt": int(expires_at),
            "humanBinding": bind,
        }

        #: Witness one: the contract's own arithmetic.
        chain_digest = bytes(
            self.contract.functions.approvalDigest(
                int(cp_id), _b32(req_hash), int(expires_at), bind
            ).call()
        )
        local_digest = approval_digest(
            self.chain_id,
            self.address,
            cp_id=cp_id,
            req_hash=req_hash,
            expires_at=expires_at,
            binding=bind,
        )
        if local_digest != chain_digest:
            raise RuntimeError(
                "our approval digest is not the vault's approvalDigest -- refusing to sign "
                f"(ours {local_digest.hex()}, chain {chain_digest.hex()})"
            )

        v, r, s = who.sign_typed_data(dom, APPROVAL_TYPES, message, "FloatApproval")

        #: Witness two: it recovers to us, not to a stranger.
        recovered = Account.recover_message(
            encode_typed_data(domain_data=dom, message_types=APPROVAL_TYPES, message_data=message),
            vrs=(v, int.from_bytes(r, "big"), int.from_bytes(s, "big")),
        )
        if recovered.lower() != who.address.lower():
            raise RuntimeError("the FloatApproval signature does not recover to our own signer")
        return v, r, s

    # --- writes -----------------------------------------------------------

    def _send(self, fn) -> dict:
        if self.signer is None:
            raise RuntimeError("this call needs a signer")
        tx = self.signer.send_transaction(
            self.w3, {"to": self.address, "data": fn._encode_transaction_data()}
        )
        tx_hash = tx if str(tx).startswith("0x") else f"0x{tx}"
        rcpt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if getattr(rcpt, "status", 1) != 1:
            raise RuntimeError(f"the transaction reverted on chain (tx {tx_hash})")
        return {"tx": tx_hash, "receipt": rcpt}

    def open_checkpoint(
        self, *, agent_id: bytes, req_hash: bytes, ttl_s: int, kind: int = KIND_SPEND
    ) -> dict:
        """Park a request. The id comes from the EVENT, not the return value.

        `openCheckpoint` returns `uint256 id`, but a return value is
        unreachable from a transaction -- only a call can read one. Simulating
        first and then sending races another checkpoint into the same id, so the
        receipt's own log is the only honest source.
        """
        out = self._send(
            self.contract.functions.openCheckpoint(
                _b32(agent_id), _b32(req_hash), int(kind), int(ttl_s)
            )
        )
        logs = self.contract.events.CheckpointOpened().process_receipt(out["receipt"])
        if not logs:
            raise RuntimeError(f"openCheckpoint emitted no CheckpointOpened (tx {out['tx']})")
        args = logs[0]["args"]
        return {
            "id": int(args["id"]),
            #: The chain's own agentId, not the one we passed in. They are the
            #: same today, and reading it back is what keeps them the same
            #: tomorrow: `executeApproved` compares the request against the
            #: STORED value, so a caller that re-derives its own is one
            #: refactor away from "agent mismatch".
            "agent_id": bytes(args["agentId"]),
            "req_hash": bytes(args["reqHash"]),
            "expires_at": int(args["expiresAt"]),
            "kind": int(args["kind"]),
            "tx": out["tx"],
        }

    def execute_approved(self, *, cp_id: int, req: SpendReq, v: int, r: bytes, s: bytes) -> dict:
        out = self._send(
            self.contract.functions.executeApproved(int(cp_id), req.as_tuple(), int(v), r, s)
        )
        return {"tx": out["tx"]}

    def resolve_checkpoint(self, *, cp_id: int, outcome: str, reason: str) -> dict:
        if outcome not in OUTCOMES:
            raise ValueError(f"outcome must be one of {sorted(OUTCOMES)}, not {outcome!r}")
        #: The vault truncates nothing, and a reason is public forever, so keep
        #: it to a sentence rather than a stack trace.
        out = self._send(
            self.contract.functions.resolveCheckpoint(int(cp_id), OUTCOMES[outcome], reason[:200])
        )
        return {"tx": out["tx"], "outcome": outcome}

    def register_guest(self, agent_id: bytes) -> dict:
        out = self._send(self.contract.functions.registerGuest(_b32(agent_id)))
        return {"tx": out["tx"]}
