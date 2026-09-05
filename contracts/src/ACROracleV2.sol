// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ACROracleV2 — a print that says how it was made.
/// @notice Everything `ACROracle` publishes, plus the four facts a verifier
///         needs to reproduce it rather than trust it:
///
///         * `policyHash`  — which cleaning policy excluded which flow. Without
///           it "the keeper decides what is wash" is an objection with no
///           answer; with it, `acr recompute --rederive-cleaning` can re-run the
///           same stack and report whether its exclusions match.
///         * `windowStart` / `windowEnd` — the span the print summarizes, so a
///           verifier recomputes over the same window rather than guessing it.
///         * `humanAdjustedBound` — the manipulation cost denominated in
///           verified humans rather than wallets.
///
///         DEPLOYED ALONGSIDE v1, NOT INSTEAD OF IT. `ACRFutures.oracle` is
///         immutable and points at v1 permanently, and `ACRFutures.settle()`
///         refuses a print older than two hours — so if v1 stopped receiving
///         prints, every expired open series would become unsettleable and its
///         collateral would sit stranded until v1 printed again. The keeper
///         posts to both during the overlap; v1 is never allowed to go stale to
///         serve v2.
///
/// @dev    v1's six signed fields are a strict PREFIX of v2's typehash. That is
///         deliberate: the off-chain payload for v2 is the v1 tuple plus four,
///         so no existing field order, test vector or byte layout shifts, and
///         one signing path serves both. Domain version is bumped to "2" so a
///         human reading a signature can tell the two apart at a glance.
contract ACROracleV2 {
    /// @notice An economic timestamp may lead block time by at most this many
    ///         seconds. Bounds the monotonicity-brick DoS.
    uint64 public constant MAX_TS_SKEW = 900; // 15 minutes

    /// @notice The widest window a print may claim to summarize, and the
    ///         staleset window it may summarize. Same spirit as MAX_TS_SKEW: a
    ///         fat-fingered window should revert, not become a published fact
    ///         nobody can reproduce.
    uint64 public constant MAX_WINDOW_SPAN = 30 days;
    uint64 public constant MAX_WINDOW_LAG = 1 days;

    struct Print {
        uint256 value; // WAD-scaled price
        uint256 ciLo; // WAD
        uint256 ciHi; // WAD
        uint256 attackCostPerBp; // USDC 1e6-scaled — cost per bp via WALLETS
        uint256 humanAdjustedBound; // USDC 1e6-scaled — via verified HUMANS; 0 = not computed
        bytes32 policyHash; // the cleaning policy this print was made under
        // The span summarized, in the SAME clock as `timestamp` (the index's
        // own Fixing clock, not unix time). windowEnd == timestamp in practice.
        uint64 windowStart; // inclusive
        uint64 windowEnd; // exclusive
        uint64 timestamp; // economic timestamp of the print (signed)
        uint64 postedAt; // block.timestamp when posted — the staleness anchor
        bool exists;
    }

    bytes32 public constant PRINT_TYPEHASH = keccak256(
        "Print(bytes32 indexId,uint256 value,uint256 ciLo,uint256 ciHi,uint256 attackCostPerBp,"
        "uint64 timestamp,uint256 humanAdjustedBound,bytes32 policyHash,uint64 windowStart,"
        "uint64 windowEnd)"
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

    /// @dev `policyHash` takes the third indexed slot (the maximum for a
    ///      non-anonymous event) rather than a data field: re-deriving the
    ///      cleaning wants "every print under policy X" as a single
    ///      `eth_getLogs` topic filter, and a bytes32 stays fully readable in a
    ///      topic. Different topic0 from v1's `PricePosted`, so an indexer
    ///      pointed at both can never mis-decode one as the other.
    event PricePosted(
        bytes32 indexed indexId,
        bytes32 indexed policyHash,
        address indexed signer,
        uint256 value,
        uint256 ciLo,
        uint256 ciHi,
        uint256 attackCostPerBp,
        uint256 humanAdjustedBound,
        uint64 windowStart,
        uint64 windowEnd,
        uint64 timestamp
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
                keccak256(bytes("2")),
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

    /// @notice The v2 EIP-712 digest. Grouped into a struct because the ten
    ///         signed fields exceed the stack otherwise, and because one
    ///         argument order in one place is the only way the calldata, the
    ///         digest and the off-chain signer can be kept in step.
    struct PrintInput {
        bytes32 indexId;
        uint256 value;
        uint256 ciLo;
        uint256 ciHi;
        uint256 attackCostPerBp;
        uint64 timestamp;
        uint256 humanAdjustedBound;
        bytes32 policyHash;
        uint64 windowStart;
        uint64 windowEnd;
    }

    function printDigest(PrintInput calldata p) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PRINT_TYPEHASH,
                p.indexId,
                p.value,
                p.ciLo,
                p.ciHi,
                p.attackCostPerBp,
                p.timestamp,
                p.humanAdjustedBound,
                p.policyHash,
                p.windowStart,
                p.windowEnd
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Publish a signed print. Callable by any relayer; authenticity is
    ///         in the signature, not in `msg.sender`.
    function postPrint(PrintInput calldata p, uint8 v, bytes32 r, bytes32 s) external {
        require(!paused, "paused");
        require(p.value > 0, "value=0");
        require(p.ciLo <= p.value && p.value <= p.ciHi, "value outside CI");
        require(p.attackCostPerBp > 0, "bound=0");
        require(p.timestamp <= block.timestamp + MAX_TS_SKEW, "ts in future");

        // A print that does not say which policy cleaned it cannot be
        // re-derived, which is the only reason the field exists.
        require(p.policyHash != bytes32(0), "no policy");

        // A print may not claim to summarize the future, an empty span, a span
        // wider than a month, or one that ended a day before it was stamped.
        require(p.windowStart < p.windowEnd, "empty window");
        require(p.windowEnd <= p.timestamp, "window ends after print");
        require(p.windowEnd - p.windowStart <= MAX_WINDOW_SPAN, "window too wide");
        require(p.timestamp - p.windowEnd <= MAX_WINDOW_LAG, "window too old");

        // ZERO MEANS "NOT COMPUTED", not "costs nothing". Attacking a benchmark
        // through verified humans is by construction at least as expensive as
        // attacking it through wallets — identities are the scarce input — so a
        // positive value below the wallet bound is a keeper bug, not a market
        // fact, and publishing it would understate the cost of moving the index.
        require(
            p.humanAdjustedBound == 0 || p.humanAdjustedBound >= p.attackCostPerBp,
            "human bound below wallet bound"
        );

        Print storage prev = _latest[p.indexId];
        require(!prev.exists || p.timestamp > prev.timestamp, "non-monotone ts");

        address signer = ecrecover(printDigest(p), v, r, s);
        require(signer != address(0) && isSigner[signer], "bad signer");

        Print memory rec = Print({
            value: p.value,
            ciLo: p.ciLo,
            ciHi: p.ciHi,
            attackCostPerBp: p.attackCostPerBp,
            humanAdjustedBound: p.humanAdjustedBound,
            policyHash: p.policyHash,
            windowStart: p.windowStart,
            windowEnd: p.windowEnd,
            timestamp: p.timestamp,
            postedAt: uint64(block.timestamp),
            exists: true
        });
        _latest[p.indexId] = rec;
        _history[p.indexId].push(rec);
        if (!_known[p.indexId]) {
            _known[p.indexId] = true;
            _indices.push(p.indexId);
        }
        emit PricePosted(
            p.indexId,
            p.policyHash,
            signer,
            p.value,
            p.ciLo,
            p.ciHi,
            p.attackCostPerBp,
            p.humanAdjustedBound,
            p.windowStart,
            p.windowEnd,
            p.timestamp
        );
    }

    // --- reads (same surface as v1, so one reader covers both) ---

    function latestPrint(bytes32 indexId) external view returns (Print memory) {
        require(_latest[indexId].exists, "no print");
        return _latest[indexId];
    }

    function latestValue(bytes32 indexId) external view returns (uint256) {
        require(_latest[indexId].exists, "no print");
        return _latest[indexId].value;
    }

    function latestPrintWithAge(bytes32 indexId)
        external
        view
        returns (Print memory print, uint256 age)
    {
        Print memory p = _latest[indexId];
        require(p.exists, "no print");
        return (p, block.timestamp - p.postedAt);
    }

    function isStale(bytes32 indexId, uint256 maxAge) external view returns (bool) {
        Print storage p = _latest[indexId];
        if (!p.exists) return true;
        return block.timestamp - p.postedAt > maxAge;
    }

    /// @notice The v2-only metadata, as one narrow read — so a consumer that
    ///         only wants the policy and window does not decode an 11-field
    ///         tuple to get them.
    function printMeta(bytes32 indexId)
        external
        view
        returns (bytes32 policyHash, uint64 windowStart, uint64 windowEnd, uint256 humanAdjustedBound)
    {
        Print memory p = _latest[indexId];
        require(p.exists, "no print");
        return (p.policyHash, p.windowStart, p.windowEnd, p.humanAdjustedBound);
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
