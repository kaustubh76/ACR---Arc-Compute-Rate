// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ACROracle
/// @notice The settlement-grade reference other contracts read. An authorized
///         signer produces an EIP-712 signature over each hourly print (value,
///         confidence interval, and attack-cost-per-bp); *any* relayer may
///         submit it via `postPrint`, and the contract verifies the signature
///         on-chain against the signer set. Prices are WAD-scaled fixed point
///         (1e18); the attack cost is USDC 1e6-scaled.
///
///         Invariants enforced on-chain — the guarantees downstream contracts
///         rely on: value within CI, a positive attack-cost bound, strictly
///         monotone economic timestamps, and an economic timestamp no more than
///         `MAX_TS_SKEW` ahead of block time (so a fat-fingered far-future
///         timestamp reverts instead of permanently bricking the feed through
///         the monotonicity rule). The owner can pause posting and rotate
///         signers; ownership transfer is two-step.
///
///         Replay: a print signature binds `indexId` (in the struct), and
///         `chainId` + this contract address (in the EIP-712 domain), so it
///         cannot be replayed to another index, chain, or oracle. Re-submitting
///         the same signed print fails the strict-monotonicity check, so no
///         nonce is required.
///
///         `_history` grows unbounded by design (~8.8k prints/index/year at
///         hourly cadence) — acceptable for a testnet reference oracle.
contract ACROracle {
    uint256 internal constant WAD = 1e18;

    /// @notice An economic timestamp may lead block time by at most this many
    ///         seconds. Bounds the monotonicity-brick DoS.
    uint64 public constant MAX_TS_SKEW = 900; // 15 minutes

    struct Print {
        uint256 value; // WAD-scaled price
        uint256 ciLo; // WAD
        uint256 ciHi; // WAD
        uint256 attackCostPerBp; // USDC 1e6-scaled
        uint64 timestamp; // economic timestamp of the print (signed)
        uint64 postedAt; // block.timestamp when posted — the staleness anchor
        bool exists;
    }

    bytes32 public constant PRINT_TYPEHASH = keccak256(
        "Print(bytes32 indexId,uint256 value,uint256 ciLo,uint256 ciHi,uint256 attackCostPerBp,uint64 timestamp)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    address public owner;
    address public pendingOwner;
    bool public paused;
    mapping(address => bool) public isSigner;

    mapping(bytes32 => Print) private _latest;
    mapping(bytes32 => Print[]) private _history;
    bytes32[] private _indices;
    mapping(bytes32 => bool) private _known;

    event PricePosted(
        bytes32 indexed indexId,
        uint256 value,
        uint256 ciLo,
        uint256 ciHi,
        uint256 attackCostPerBp,
        uint64 timestamp,
        address indexed signer
    );
    event SignerSet(address indexed signer, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);
    event PausedSet(bool paused);

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
                keccak256(bytes("ACR Oracle")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // --- admin ---

    function setSigner(address signer, bool allowed) external onlyOwner {
        isSigner[signer] = allowed;
        emit SignerSet(signer, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Begin a two-step ownership transfer. `to` must call
    ///         `acceptOwnership` to complete it, guarding against a mistyped
    ///         address permanently orphaning control.
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

    // --- posting ---

    /// @notice EIP-712 digest for a print. Exposed for off-chain signers and
    ///         cross-implementation parity tests.
    function printDigest(
        bytes32 indexId,
        uint256 value,
        uint256 ciLo,
        uint256 ciHi,
        uint256 attackCostPerBp,
        uint64 timestamp
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(PRINT_TYPEHASH, indexId, value, ciLo, ciHi, attackCostPerBp, timestamp)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Publish a signed print for `indexId`. Callable by any relayer;
    ///         the print's authenticity comes from the EIP-712 signature, not
    ///         from `msg.sender`. Reverts unless every benchmark invariant holds.
    function postPrint(
        bytes32 indexId,
        uint256 value,
        uint256 ciLo,
        uint256 ciHi,
        uint256 attackCostPerBp,
        uint64 timestamp,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(!paused, "paused");
        require(value > 0, "value=0");
        require(ciLo <= value && value <= ciHi, "value outside CI");
        require(attackCostPerBp > 0, "bound=0");
        require(timestamp <= block.timestamp + MAX_TS_SKEW, "ts in future");
        Print storage prev = _latest[indexId];
        require(!prev.exists || timestamp > prev.timestamp, "non-monotone ts");

        bytes32 digest = printDigest(indexId, value, ciLo, ciHi, attackCostPerBp, timestamp);
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && isSigner[signer], "bad signer");

        Print memory p = Print({
            value: value,
            ciLo: ciLo,
            ciHi: ciHi,
            attackCostPerBp: attackCostPerBp,
            timestamp: timestamp,
            postedAt: uint64(block.timestamp),
            exists: true
        });
        _latest[indexId] = p;
        _history[indexId].push(p);
        if (!_known[indexId]) {
            _known[indexId] = true;
            _indices.push(indexId);
        }
        emit PricePosted(indexId, value, ciLo, ciHi, attackCostPerBp, timestamp, signer);
    }

    // --- reads ---

    /// @notice Latest print for an index. Used by instruments to cash-settle.
    function latestPrint(bytes32 indexId) external view returns (Print memory) {
        require(_latest[indexId].exists, "no print");
        return _latest[indexId];
    }

    /// @notice Latest value only (WAD-scaled), convenience for settlement math.
    function latestValue(bytes32 indexId) external view returns (uint256) {
        require(_latest[indexId].exists, "no print");
        return _latest[indexId].value;
    }

    /// @notice Latest print plus its age in seconds (`block.timestamp - postedAt`).
    ///         Consumers should reject a settlement if `age` exceeds their
    ///         tolerance — the settlement-grade freshness guard.
    function latestPrintWithAge(bytes32 indexId)
        external
        view
        returns (Print memory print, uint256 age)
    {
        Print memory p = _latest[indexId];
        require(p.exists, "no print");
        return (p, block.timestamp - p.postedAt);
    }

    /// @notice True if there is no print for `indexId`, or the latest is older
    ///         than `maxAge` seconds. The cheap staleness check for settlement.
    function isStale(bytes32 indexId, uint256 maxAge) external view returns (bool) {
        Print storage p = _latest[indexId];
        if (!p.exists) return true;
        return block.timestamp - p.postedAt > maxAge;
    }

    function historyLength(bytes32 indexId) external view returns (uint256) {
        return _history[indexId].length;
    }

    function historyAt(bytes32 indexId, uint256 i) external view returns (Print memory) {
        return _history[indexId][i];
    }

    function indexCount() external view returns (uint256) {
        return _indices.length;
    }

    function indexAt(uint256 i) external view returns (bytes32) {
        return _indices[i];
    }
}
