// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ReceiptMirror — an off-chain Gateway settlement, made indexable on-chain.
/// @notice Circle Gateway settles x402 nanopayments off-chain and returns a batch
///         UUID, not a transaction. There is therefore NO settlement event on Arc
///         for a subgraph to index, and the only ledger is a JSONL file
///         (`services/index_api/index_api/receipts_live.jsonl`). A keeper-signed
///         mirror is the only path — the same conclusion `FeedAccessAttestor`
///         reached, and the same shape.
///
///         TWO PHASES, because the two facts arrive at different times. Phase 1
///         posts as soon as `/v1/x402/settle` returns: payer, seller, amount, the
///         off-chain settlement time, the Gateway ref. Phase 2 posts once the
///         quantity has been decoded from the receipt. The split is not
///         bookkeeping: it commits the ARRIVAL ANCHOR (`settledAt`) before the
///         quantity — and therefore before the unit price — is known, so the
///         keeper cannot see what its own benchmark would be and then choose it.
///
///         Phase 2 carries its own signature. `quantity` is the denominator of
///         every published slippage number, so an unsigned finalize would rest
///         the whole benchmark on `msg.sender` being the keeper — the hot-key-as-
///         authority this contract family exists to avoid. `FINALIZE_TYPEHASH`
///         binds `settlementId`, so a finalize signature is provably about one
///         open record and cannot be lifted onto another.
///
/// @dev    Mirrors `FeedAccessAttestor`'s idioms on purpose — same domain
///         separator construction, same public digest views, same `isSigner`
///         authorization, same two-step ownership — so one reviewer's
///         understanding covers both. Replay protection differs: a settlement,
///         unlike a feed grant, already has a unique off-chain artifact, so the
///         Gateway ref IS the nonce and no synthetic nonce space is needed.
contract ReceiptMirror {
    // Units, once, so nothing downstream has to guess:
    //   amountUsdc  USDC, 1e6 (Arc's native USDC decimals).
    //   quantity    WAD 1e18, in the INDEX's own unit — 1,500 tokens against a
    //               per-1k-token index is 1.5e18. WAD-scaling gives sub-unit
    //               resolution and makes the subgraph's arithmetic exactly
    //               `amountUsdc * 1e30 / quantity`, in WAD USD per unit.
    //   settledAt   unix seconds, from the Gateway settle response.
    //   unit        the Service enum the index prices (0 INFERENCE, 1 GPU, 2 DATA).
    //   gatewayRef  bytes32. A Gateway ref is a 16-byte UUID today, left-padded;
    //               `refKind()` in the Terminal already anticipates a 32-byte tx
    //               ref, and the extra calldata is free beside a signature.

    bytes32 public constant OPEN_TYPEHASH = keccak256(
        "OpenSettlement(bytes32 settlementId,address payer,address seller,bytes32 indexId,"
        "uint256 amountUsdc,uint64 settledAt,bytes32 gatewayRef,bool synthetic)"
    );
    bytes32 public constant FINALIZE_TYPEHASH =
        keccak256("FinalizeSettlement(bytes32 settlementId,uint8 unit,uint256 quantity)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice How far back the ordinary mirror path may reach. Prints are
    ///         hourly, so an hour leaves at most ONE print boundary inside the
    ///         reachable window — and `lastSettledAt` makes reaching for it
    ///         self-defeating.
    uint64 public constant MAX_MIRROR_LAG = 1 hours;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isSigner;

    struct Settlement {
        // slot 0 — 20 + 8 + 1 + 1 + 1 + 1 = 32 bytes exactly.
        address payer;
        uint64 settledAt; // PHASE 1 ONLY. Never written again.
        uint8 unit;
        bool synthetic;
        bool late;
        bool finalized;
        // slot 1
        address seller;
        uint64 openedAt;
        // slots 2-4
        bytes32 indexId;
        uint256 amountUsdc;
        uint256 quantity; // 0 until finalized
    }

    mapping(bytes32 => Settlement) public settlements;
    /// @notice One mirror per Gateway batch ref — the natural replay guard.
    mapping(bytes32 => bool) public refUsed;
    /// @notice Per-payer monotone floor on `settledAt`. See `_open`.
    mapping(address => uint64) public lastSettledAt;

    /// @dev `mirrorLagSeconds` is emitted rather than left to be derived
    ///      off-chain, so the keeper's promptness is a queryable fact.
    event SettlementOpened(
        bytes32 indexed settlementId,
        address indexed payer,
        address indexed seller,
        bytes32 indexId,
        uint256 amountUsdc,
        uint64 settledAt,
        uint64 mirrorLagSeconds,
        bytes32 gatewayRef,
        bool synthetic,
        bool late
    );

    /// @dev Re-emits payer and seller although the open record holds them: two
    ///      topics buy the subgraph a `Settlement` write with no store read, and
    ///      make the event self-sufficient in an explorer.
    event SettlementFinalized(
        bytes32 indexed settlementId,
        address indexed payer,
        address indexed seller,
        uint8 unit,
        uint256 quantity,
        uint64 finalizeLagSeconds
    );

    event SignerSet(address indexed signer, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        isSigner[msg.sender] = true;
        emit SignerSet(msg.sender, true);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Receipt Mirror")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        isSigner[signer] = allowed;
        emit SignerSet(signer, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero owner");
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnerTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // --- digests -------------------------------------------------------------
    // Exposed so an off-chain signer can check itself against the chain's own
    // arithmetic rather than against a reimplementation of it.

    function openDigest(
        bytes32 settlementId,
        address payer,
        address seller,
        bytes32 indexId,
        uint256 amountUsdc,
        uint64 settledAt,
        bytes32 gatewayRef,
        bool synthetic
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                OPEN_TYPEHASH,
                settlementId,
                payer,
                seller,
                indexId,
                amountUsdc,
                settledAt,
                gatewayRef,
                synthetic
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function finalizeDigest(bytes32 settlementId, uint8 unit, uint256 quantity)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(FINALIZE_TYPEHASH, settlementId, unit, quantity));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // --- phase 1 -------------------------------------------------------------

    /// @notice Mirror a settlement. Permissionless to relay: authenticity is in
    ///         the signature, not in `msg.sender`.
    function openSettlement(
        bytes32 settlementId,
        address payer,
        address seller,
        bytes32 indexId,
        uint256 amountUsdc,
        uint64 settledAt,
        bytes32 gatewayRef,
        bool synthetic,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _open(
            settlementId, payer, seller, indexId, amountUsdc, settledAt,
            gatewayRef, synthetic, false, v, r, s
        );
    }

    /// @notice The honest-backlog path: exempt from `MAX_MIRROR_LAG`, still bound
    ///         by every other guard, and every record it writes is flagged
    ///         `late`. An outage should cost a label, not a hole in the tape —
    ///         and a label a reader can filter on is worth more than a rule that
    ///         quietly gets relaxed when it becomes inconvenient. Owner-only,
    ///         because it is an operator decision rather than a keeper one.
    function openSettlementLate(
        bytes32 settlementId,
        address payer,
        address seller,
        bytes32 indexId,
        uint256 amountUsdc,
        uint64 settledAt,
        bytes32 gatewayRef,
        bool synthetic,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyOwner {
        _open(
            settlementId, payer, seller, indexId, amountUsdc, settledAt,
            gatewayRef, synthetic, true, v, r, s
        );
    }

    function _open(
        bytes32 settlementId,
        address payer,
        address seller,
        bytes32 indexId,
        uint256 amountUsdc,
        uint64 settledAt,
        bytes32 gatewayRef,
        bool synthetic,
        bool late,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        require(settlementId != bytes32(0), "zero id");
        require(payer != address(0) && seller != address(0), "zero party");
        require(amountUsdc > 0, "zero amount");
        require(settlements[settlementId].openedAt == 0, "already opened");
        require(!refUsed[gatewayRef], "ref already mirrored");

        // G1 — nothing settles in the future. Checked BEFORE the lag arithmetic
        // below, which would otherwise underflow and revert with a bare panic
        // instead of saying what was wrong.
        require(settledAt <= block.timestamp, "settled in the future");
        uint64 lag = uint64(block.timestamp) - settledAt;

        // G2 — bounds how far back the ordinary path may reach.
        require(late || lag <= MAX_MIRROR_LAG, "mirror too late");

        // G3 — per-payer monotone. This is the guard that actually kills
        // backdating: to profit, the keeper would have to sit on a receipt until
        // it saw whether the next print moved in its favour, and doing that
        // freezes that payer's entire mirror stream behind the withheld one.
        // Non-strict, so a batch settling within the same second still mirrors.
        require(settledAt >= lastSettledAt[payer], "backdated for payer");

        address signer = ecrecover(
            openDigest(
                settlementId, payer, seller, indexId, amountUsdc, settledAt,
                gatewayRef, synthetic
            ),
            v, r, s
        );
        require(signer != address(0) && isSigner[signer], "bad signer");

        refUsed[gatewayRef] = true;
        lastSettledAt[payer] = settledAt;

        Settlement storage sm = settlements[settlementId];
        sm.payer = payer;
        sm.settledAt = settledAt;
        sm.synthetic = synthetic;
        sm.late = late;
        sm.seller = seller;
        sm.openedAt = uint64(block.timestamp);
        sm.indexId = indexId;
        sm.amountUsdc = amountUsdc;

        emit SettlementOpened(
            settlementId, payer, seller, indexId, amountUsdc, settledAt, lag,
            gatewayRef, synthetic, late
        );
    }

    // --- phase 2 -------------------------------------------------------------

    /// @notice Add the decoded quantity to an open settlement.
    /// @dev    Cannot reach `settledAt`, `amountUsdc`, `payer`, `seller` or
    ///         `indexId`. Phase 2 may only ADD — the arrival anchor was committed
    ///         in phase 1 and is structurally out of reach here. That is the
    ///         entire point of the split.
    function finalizeSettlement(
        bytes32 settlementId,
        uint8 unit,
        uint256 quantity,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Settlement storage sm = settlements[settlementId];
        require(sm.openedAt != 0, "not opened");
        require(!sm.finalized, "already finalized");
        require(quantity > 0, "zero quantity");

        address signer = ecrecover(finalizeDigest(settlementId, unit, quantity), v, r, s);
        require(signer != address(0) && isSigner[signer], "bad signer");

        sm.unit = unit;
        sm.quantity = quantity;
        sm.finalized = true;

        emit SettlementFinalized(
            settlementId,
            sm.payer,
            sm.seller,
            unit,
            quantity,
            uint64(block.timestamp) - sm.openedAt
        );
    }

    /// @notice Whether a settlement has both phases on chain — the single call a
    ///         reader needs before treating its unit price as final.
    function isFinalized(bytes32 settlementId) external view returns (bool) {
        return settlements[settlementId].finalized;
    }
}
