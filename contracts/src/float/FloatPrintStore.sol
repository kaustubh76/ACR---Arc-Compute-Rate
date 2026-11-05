// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title FloatPrintStore — per-model compute prices, with an identity a spend can be bound to.
/// @notice ACR's `ACROracleV2` prints the index. This store prints the PRICE OF A
///         MODEL, which is a different number with a different job, and keeping
///         them in separate contracts is deliberate on two counts.
///
///         FIRST, THE UNITS ARE NOT COMPARABLE. `anchors/GAP.md` records ACR's
///         published index reference levels sitting 20x to 1250x away from real
///         market prices — the index is a benchmark whose LEVEL is not a dollar
///         quote. Banding a USDC invoice against it would refuse every honest
///         quote and accept nothing, or the reverse, depending on the index. What
///         a treasury needs to authorize a payment is the price a seller would
///         actually charge for the thing being bought. So this store carries
///         per-model USD prices built the same way ACR builds everything —
///         trimmed median across providers, with a confidence interval — and the
///         estimator and the index oracle are left exactly as they were.
///
///         SECOND, A PRINT NEEDS AN INJECTIVE IDENTITY. `ACROracleV2` identifies
///         a print by `(indexId, postedAt)`, and that is not unique: two indices
///         written in one block share `postedAt`, and a retried keeper
///         transaction re-posts at the same block time carrying a different
///         value. The vault must be able to refuse "the print rotated between
///         your quote and your payment" SEPARATELY from "this print is stale",
///         because those are different failures with different fixes — one is
///         re-quote, the other is fix the keeper. A monotonically incrementing
///         `printId` per index makes that distinction enforceable on chain.
///
/// @dev    Mirrors `ACROracleV2`'s idioms on purpose — same `isSigner` allowlist,
///         same `paused` kill switch, same two-step ownership, same
///         `latestPrintPrimitive` signature — so one reviewer's understanding
///         covers both, and so this store is drop-in swappable for the real
///         oracle the day per-model prints move there.
contract FloatPrintStore {
    /// Units, once, so nothing downstream has to guess:
    ///   priceWad — USD per BUNDLE of the resource, at 1e18. Per bundle, not per
    ///              token: a per-token price of 4e-7 USD truncates to zero in
    ///              6-decimal USDC and every quote would then read as over-band.
    ///              A bundle is per 1k tokens, per GPU-second, per MB — whatever
    ///              the index's unit says, chosen so the price is never dust.
    ///   ciBps    — half-width of the confidence interval, in basis points of
    ///              the price. The forecaster spends this as its safety margin.
    ///   postedAt — block.timestamp at write. CHAIN time, which is what staleness
    ///              must be measured against; a signer-supplied economic clock
    ///              can lead block time and would underflow the comparison.
    struct Print {
        uint128 priceWad;
        uint64 printId;
        uint64 postedAt;
        uint32 ciBps;
    }

    address public owner;
    address public pendingOwner;
    bool public paused;

    /// @notice Who may write a print. Plural because the keeper rotates keys and
    ///         revoking one should not stop the press.
    mapping(address => bool) public isSigner;

    /// @notice The human name behind an index id, e.g.
    ///         "ACR-INF:meta-llama/llama-3.3-70b-instruct".
    /// @dev    Index ids are `keccak256(name)` because a name does not fit:
    ///         that example is 41 bytes and a `bytes32` key holds 32. Without
    ///         this mapping a receipt would name a hash, and the dashboard would
    ///         need an off-chain lookup table to say WHICH model was bought —
    ///         which would make "every number on this page is read from Arc"
    ///         false in the one place a reader would check it. Written once per
    ///         index and never changed, so the label a receipt cites cannot be
    ///         rewritten after the fact.
    mapping(bytes32 => string) public indexName;

    mapping(bytes32 => Print) private _latest;
    mapping(bytes32 => Print[]) private _history;
    bytes32[] private _indices;
    mapping(bytes32 => bool) private _known;

    event PrintPosted(
        bytes32 indexed index,
        uint64 indexed printId,
        address indexed signer,
        uint256 priceWad,
        uint32 ciBps,
        uint64 postedAt
    );
    event IndexNamed(bytes32 indexed index, string name);
    event SignerSet(address indexed signer, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // --- administration ------------------------------------------------------

    function setSigner(address signer, bool allowed) external onlyOwner {
        require(signer != address(0), "zero signer");
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

    // --- writing -------------------------------------------------------------

    /// @notice Record what an index id means, once.
    /// @dev    The id must be `keccak256(name)`, and the contract CHECKS that
    ///         rather than trusting it: a store that let a signer attach any
    ///         label to any id would let a cheap model's price be presented as
    ///         an expensive one's, which is precisely the substitution the fair
    ///         band exists to prevent.
    function nameIndex(bytes32 index, string calldata name) external {
        require(isSigner[msg.sender], "not signer");
        require(bytes(name).length > 0, "empty name");
        require(bytes(indexName[index]).length == 0, "already named");
        require(keccak256(bytes(name)) == index, "name is not this index");
        indexName[index] = name;
        emit IndexNamed(index, name);
    }

    /// @notice Write the current price for one index.
    /// @dev    `printId` increments per index and never repeats, so a spend that
    ///         names a `printId` names exactly one price. History is appended so a
    ///         receipt that cites a `printId` stays independently checkable after
    ///         the price has moved on — which is the difference between a dashboard
    ///         that asserts a fair price and one that can be audited.
    function setPrint(bytes32 index, uint256 priceWad, uint32 ciBps) external returns (uint64) {
        require(!paused, "paused");
        require(isSigner[msg.sender], "not signer");
        require(index != bytes32(0), "zero index");
        require(priceWad > 0, "zero price");
        require(priceWad <= type(uint128).max, "price too large");
        // A confidence interval wider than the price itself is not a confidence
        // interval, and the forecaster multiplies by (1 + ci) — so bound it.
        require(ciBps <= 10_000, "ci too wide");

        Print storage p = _latest[index];
        uint64 nextId = p.printId + 1;
        p.priceWad = uint128(priceWad);
        p.printId = nextId;
        p.postedAt = uint64(block.timestamp);
        p.ciBps = ciBps;

        _history[index].push(Print(uint128(priceWad), nextId, uint64(block.timestamp), ciBps));
        if (!_known[index]) {
            _known[index] = true;
            _indices.push(index);
        }

        emit PrintPosted(index, nextId, msg.sender, priceWad, ciBps, uint64(block.timestamp));
        return nextId;
    }

    // --- reading -------------------------------------------------------------

    /// @notice The current print. `printId == 0` means there has never been one.
    /// @dev    Does not revert on an unknown index. The vault has to be able to
    ///         say "no print for index" as a normal refusal with its own reason
    ///         string, and a view that reverts would turn that refusal into a
    ///         failed transaction with no event — exactly the failure mode this
    ///         design is trying to avoid everywhere else.
    function latest(bytes32 index)
        external
        view
        returns (uint256 priceWad, uint64 printId, uint64 postedAt, uint32 ciBps)
    {
        Print memory p = _latest[index];
        return (p.priceWad, p.printId, p.postedAt, p.ciBps);
    }

    /// @notice Byte-identical to `ACROracleV2.latestPrintPrimitive`, so the
    ///         existing readers in `scripts/` and `graph/` work against either.
    function latestPrintPrimitive(bytes32 index)
        external
        view
        returns (bool exists, uint256 value, uint64 postedAt)
    {
        Print memory p = _latest[index];
        return (p.printId != 0, p.priceWad, p.postedAt);
    }

    /// @notice True when there is no print, or the one there is has aged out.
    /// @dev    Absence counts as stale — the same choice `ACROracleV2.isStale`
    ///         makes. A caller asking "may I rely on this?" gets no for both.
    function isStale(bytes32 index, uint256 maxAge) external view returns (bool) {
        Print memory p = _latest[index];
        if (p.printId == 0) return true;
        return block.timestamp - p.postedAt > maxAge;
    }

    function historyLength(bytes32 index) external view returns (uint256) {
        return _history[index].length;
    }

    function historyAt(bytes32 index, uint256 i) external view returns (Print memory) {
        require(i < _history[index].length, "out of range");
        return _history[index][i];
    }

    function indexCount() external view returns (uint256) {
        return _indices.length;
    }

    function indexAt(uint256 i) external view returns (bytes32) {
        require(i < _indices.length, "out of range");
        return _indices[i];
    }
}
