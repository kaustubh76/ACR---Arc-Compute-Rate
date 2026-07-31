// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of ACROracle this contract settles against. `latestValue`
///         is the WAD-scaled mark; `latestPrintWithAge` carries the staleness
///         anchor so settlement can refuse a stale feed.
interface IACROracle {
    struct Print {
        uint256 value;
        uint256 ciLo;
        uint256 ciHi;
        uint256 attackCostPerBp;
        uint64 timestamp;
        uint64 postedAt;
        bool exists;
    }

    function latestValue(bytes32 indexId) external view returns (uint256);
    function latestPrintWithAge(bytes32 indexId) external view returns (Print memory print, uint256 age);
}

/// @notice Minimal ERC-20 surface for USDC collateral (6 decimals on Arc).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ACRFutures
/// @notice Pillar 4, on-chain. A weekly **cash-settled future** on an ACR index
///         that resolves against `ACROracle.latestPrint` — the same
///         settlement-grade feed the spot indices post to. This is the surviving
///         form of the "capacity forwards" idea with delivery deleted: at expiry
///         a position simply cash-settles against the oracle mark, so there is no
///         delivery-enforcement problem.
///
///         Model (mirrors `acr_instrument.Position` byte-for-byte so the Python
///         maker and the chain agree — the same cross-implementation discipline
///         `ACROracle.printDigest` uses): each `trade` fills at the oracle mark
///         and the **designated maker takes the exact mirror side** (the
///         Avellaneda–Stoikov maker that bootstraps the book). Per series the net
///         position therefore always sums to zero. Positions carry a
///         volume-weighted entry and realize PnL on reduce/flip, all in WAD.
///
///         Collateral is USDC (6-dp). A trade is refused if it would leave either
///         side below `MARGIN_BPS` initial margin on the resulting notional.
///         `settle` freezes the oracle mark once past expiry (rejecting a stale
///         print) and runs a **socialized-loss clearing**: a trader can never
///         lose more than they posted, and any shortfall haircuts the winners
///         pro-rata — so distributed collateral exactly equals the pot (no mint,
///         no underflow). Initial margin only; there is no intraday liquidation
///         (a deliberate testnet-reference simplification, documented).
///
///         Admin idioms are copied from `ACROracle`: two-step ownership and a
///         `paused` switch on state-changing entrypoints.
contract ACRFutures {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDC = 1e6;
    uint256 internal constant BPS = 1e4;
    /// @notice WAD·USDC / USDC-6 conversion factor: a PnL held in WAD
    ///         value·contracts becomes USDC-6 via `* multiplier / WAD_USDC`.
    uint256 internal constant WAD_USDC = 1e12; // WAD (1e18) / USDC (1e6)

    /// @notice A settlement print may be at most this old (seconds) — the
    ///         freshness guard, mirroring the oracle's own settlement contract.
    uint64 public constant MAX_SETTLE_AGE = 7200; // 2 hours

    /// @notice Bounds `settle` gas: a series accepts at most this many distinct
    ///         participants (maker + takers), since clearing iterates them.
    uint256 public constant MAX_TRADERS = 128;

    /// @notice A trader's net position in a series — the on-chain twin of
    ///         `acr_instrument.future.Position`. All fields WAD-scaled; contracts
    ///         and realizedPnl are signed (+long / −short).
    struct Position {
        int256 contracts; // WAD contracts
        int256 avgPrice; // WAD price (always ≥ 0)
        int256 realizedPnl; // WAD value·contracts (pre-multiplier), like Python
    }

    struct Series {
        bytes32 indexId;
        uint64 expiryTs;
        uint256 multiplier; // USDC per 1.0 of index value per contract (e.g. 1000)
        address maker; // the counterparty to every taker fill
        bool exists;
        bool settled;
        uint256 settlementPrice; // WAD; frozen at settle
    }

    /// @notice Initial-margin requirement in basis points of notional.
    uint256 public immutable MARGIN_BPS;
    IACROracle public immutable oracle;
    IERC20 public immutable usdc;

    address public owner;
    address public pendingOwner;
    bool public paused;

    Series[] private _series;
    // seriesId => trader => position
    mapping(uint256 => mapping(address => Position)) private _positions;
    // seriesId => trader => posted USDC-6 collateral
    mapping(uint256 => mapping(address => uint256)) public collateral;
    // seriesId => participant list (for settle clearing) + membership guard
    mapping(uint256 => address[]) private _traders;
    mapping(uint256 => mapping(address => bool)) private _isTrader;

    bool private _locked;

    event SeriesOpened(
        uint256 indexed seriesId, bytes32 indexed indexId, uint64 expiryTs, uint256 multiplier, address maker
    );
    event CollateralPosted(uint256 indexed seriesId, address indexed trader, uint256 amount);
    event CollateralWithdrawn(uint256 indexed seriesId, address indexed trader, uint256 amount);
    event Traded(uint256 indexed seriesId, address indexed taker, int256 qty, uint256 mark);
    event Settled(uint256 indexed seriesId, uint256 settlementPrice, uint256 participants);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);
    event PausedSet(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address oracle_, address usdc_, uint256 marginBps_) {
        require(oracle_ != address(0) && usdc_ != address(0), "zero addr");
        require(marginBps_ > 0 && marginBps_ <= BPS, "bad margin");
        owner = msg.sender;
        oracle = IACROracle(oracle_);
        usdc = IERC20(usdc_);
        MARGIN_BPS = marginBps_;
    }

    // --- admin (idioms copied from ACROracle) ---

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

    // --- series lifecycle ---

    /// @notice Open a new series. Reverts unless the oracle already prints
    ///         `indexId` (so there is a mark to trade against) and the expiry is
    ///         in the future. The `maker` is the mirror counterparty to every
    ///         taker fill and must post collateral like any other trader.
    function openSeries(bytes32 indexId, uint64 expiryTs, uint256 multiplier, address maker)
        external
        onlyOwner
        returns (uint256 seriesId)
    {
        require(expiryTs > block.timestamp, "expiry in past");
        require(multiplier > 0, "multiplier=0");
        require(maker != address(0), "zero maker");
        require(oracle.latestValue(indexId) > 0, "no oracle print"); // reverts "no print" if absent
        seriesId = _series.length;
        _series.push(
            Series({
                indexId: indexId,
                expiryTs: expiryTs,
                multiplier: multiplier,
                maker: maker,
                exists: true,
                settled: false,
                settlementPrice: 0
            })
        );
        _join(seriesId, maker);
        emit SeriesOpened(seriesId, indexId, expiryTs, multiplier, maker);
    }

    // --- collateral ---

    function postCollateral(uint256 seriesId, uint256 amount) external notPaused nonReentrant {
        Series storage s = _series[seriesId];
        require(s.exists, "no series");
        require(!s.settled, "settled");
        require(amount > 0, "amount=0");
        _join(seriesId, msg.sender);
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        collateral[seriesId][msg.sender] += amount;
        emit CollateralPosted(seriesId, msg.sender, amount);
    }

    /// @notice Withdraw free collateral. Before settlement, the resulting balance
    ///         must still cover initial margin on the open position; after
    ///         settlement positions are flat, so the full cleared balance is free.
    function withdrawCollateral(uint256 seriesId, uint256 amount) external nonReentrant {
        Series storage s = _series[seriesId];
        require(s.exists, "no series");
        uint256 bal = collateral[seriesId][msg.sender];
        require(amount <= bal, "insufficient");
        uint256 remaining = bal - amount;
        if (!s.settled) {
            require(remaining >= _requiredMargin(seriesId, msg.sender), "below margin");
        }
        collateral[seriesId][msg.sender] = remaining;
        require(usdc.transfer(msg.sender, amount), "transfer failed");
        emit CollateralWithdrawn(seriesId, msg.sender, amount);
    }

    // --- trading ---

    /// @notice Trade `qty` contracts (signed: +long / −short) at the current
    ///         oracle mark. The maker takes the exact mirror. Both sides must
    ///         clear initial margin on their resulting notional or the trade
    ///         reverts. Cash-settled index futures fill at the mid; the A–S
    ///         bid/ask spread lives off-chain as the quote a taker sees first.
    function trade(uint256 seriesId, int256 qty) external notPaused nonReentrant {
        Series storage s = _series[seriesId];
        require(s.exists, "no series");
        require(!s.settled, "settled");
        require(block.timestamp < s.expiryTs, "expired");
        require(qty != 0, "qty=0");
        require(msg.sender != s.maker, "maker cannot take");

        uint256 mark = oracle.latestValue(s.indexId); // reverts "no print" if feed gone
        require(mark > 0, "no mark");

        _join(seriesId, msg.sender);

        int256 markI = int256(mark);
        _applyFill(_positions[seriesId][msg.sender], qty, markI);
        _applyFill(_positions[seriesId][s.maker], -qty, markI);

        require(collateral[seriesId][msg.sender] >= _requiredMargin(seriesId, msg.sender), "taker margin");
        require(collateral[seriesId][s.maker] >= _requiredMargin(seriesId, s.maker), "maker margin");

        emit Traded(seriesId, msg.sender, qty, mark);
    }

    // --- settlement ---

    /// @notice Cash-settle the series against the oracle once past expiry. Reads
    ///         `latestPrintWithAge` and rejects a print older than
    ///         `MAX_SETTLE_AGE` (the freshness guard). Runs socialized-loss
    ///         clearing: every position realizes vs the frozen mark, losers are
    ///         floored at zero collateral, and the resulting shortfall haircuts
    ///         winners pro-rata — distributed collateral equals the pot exactly.
    function settle(uint256 seriesId) external nonReentrant {
        Series storage s = _series[seriesId];
        require(s.exists, "no series");
        require(!s.settled, "already settled");
        require(block.timestamp >= s.expiryTs, "not expired");

        (IACROracle.Print memory p, uint256 age) = oracle.latestPrintWithAge(s.indexId);
        require(p.exists && p.value > 0, "no print");
        require(age <= MAX_SETTLE_AGE, "stale print");

        uint256 settlePrice = p.value;
        s.settlementPrice = settlePrice;
        s.settled = true;

        address[] storage tr = _traders[seriesId];
        uint256 n = tr.length;

        // Pass 1: realize each position → target entitlement = collateral + pnl.
        // Losers (entitlement < 0) are floored to 0, accumulating a shortfall;
        // winners' positive entitlements are summed for the pro-rata haircut.
        int256[] memory entitlement = new int256[](n);
        uint256 shortfall = 0;
        uint256 totalWinners = 0;
        for (uint256 i = 0; i < n; i++) {
            address t = tr[i];
            int256 pnl = _cashPnl(_positions[seriesId][t], int256(settlePrice), s.multiplier);
            int256 ent = int256(collateral[seriesId][t]) + pnl;
            if (ent < 0) {
                shortfall += uint256(-ent);
                ent = 0;
            } else {
                totalWinners += uint256(ent);
            }
            entitlement[i] = ent;
        }

        // Pass 2: haircut winners pro-rata to cover the shortfall, then write the
        // cleared collateral and flatten positions. Any integer-division dust
        // (≤ n wei of USDC-6) stays locked — negligible.
        for (uint256 i = 0; i < n; i++) {
            address t = tr[i];
            uint256 ent = uint256(entitlement[i]);
            if (ent > 0 && shortfall > 0 && totalWinners > 0) {
                // Round the haircut UP so total distributed never exceeds the
                // pot (any dust stays locked — the safe direction; the opposite
                // would let withdrawals underflow the USDC balance).
                uint256 cut = (shortfall * ent + totalWinners - 1) / totalWinners;
                ent = ent > cut ? ent - cut : 0;
            }
            collateral[seriesId][t] = ent;
            delete _positions[seriesId][t];
        }

        emit Settled(seriesId, settlePrice, n);
    }

    // --- position math (ports acr_instrument.future.Position) ---

    /// @dev Faithful port of `Position.apply_fill`: realize PnL on the closed
    ///      portion when reducing/flipping, then update the volume-weighted entry.
    ///      Uses the OLD contracts value throughout, exactly like the Python.
    function _applyFill(Position storage pos, int256 qty, int256 price) internal {
        int256 oldC = pos.contracts;
        int256 newC = oldC + qty;

        // Reducing or flipping realizes PnL on the closed portion.
        if (oldC != 0 && (oldC > 0) != (qty > 0)) {
            int256 closed = _absMin(qty, oldC);
            int256 direction = oldC > 0 ? int256(1) : int256(-1);
            pos.realizedPnl += (closed * direction * (price - pos.avgPrice)) / int256(WAD);
        }

        if (newC == 0) {
            pos.avgPrice = 0;
        } else if ((oldC >= 0) == (qty >= 0) && oldC != 0) {
            // Adding in the same direction: blend entry price (|contracts|-weighted).
            pos.avgPrice = (pos.avgPrice * _abs(oldC) + price * _abs(qty)) / _abs(newC);
        } else if ((oldC > 0) != (qty > 0) && _abs(qty) > _abs(oldC)) {
            pos.avgPrice = price; // flipped past flat
        } else if (oldC == 0) {
            pos.avgPrice = price;
        }
        pos.contracts = newC;
    }

    /// @dev Total cash PnL (USDC-6, signed) if `pos` settles at `settlePrice`:
    ///      realized + unrealized, scaled by the series multiplier.
    function _cashPnl(Position storage pos, int256 settlePrice, uint256 multiplier)
        internal
        view
        returns (int256)
    {
        int256 unrealized = (pos.contracts * (settlePrice - pos.avgPrice)) / int256(WAD);
        int256 totalWad = pos.realizedPnl + unrealized; // WAD value·contracts
        return (totalWad * int256(multiplier)) / int256(WAD_USDC);
    }

    /// @dev Required initial margin (USDC-6) for a trader's current position at
    ///      the live mark: |contracts| · mark · multiplier · MARGIN_BPS.
    function _requiredMargin(uint256 seriesId, address trader) internal view returns (uint256) {
        Series storage s = _series[seriesId];
        int256 c = _positions[seriesId][trader].contracts;
        if (c == 0) return 0;
        uint256 mark = oracle.latestValue(s.indexId);
        uint256 notionalUsdc = (uint256(_abs(c)) * mark * s.multiplier) / (WAD * WAD_USDC);
        return (notionalUsdc * MARGIN_BPS) / BPS;
    }

    // --- reads ---

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    function getSeries(uint256 seriesId) external view returns (Series memory) {
        require(_series[seriesId].exists, "no series");
        return _series[seriesId];
    }

    function positionOf(uint256 seriesId, address trader) external view returns (Position memory) {
        return _positions[seriesId][trader];
    }

    /// @notice Mark-to-oracle unrealized PnL (USDC-6, signed) for an open
    ///         position at the current feed value.
    function unrealizedPnl(uint256 seriesId, address trader) external view returns (int256) {
        Series storage s = _series[seriesId];
        require(s.exists, "no series");
        uint256 mark = oracle.latestValue(s.indexId);
        return _cashPnl(_positions[seriesId][trader], int256(mark), s.multiplier);
    }

    function traderCount(uint256 seriesId) external view returns (uint256) {
        return _traders[seriesId].length;
    }

    function traderAt(uint256 seriesId, uint256 i) external view returns (address) {
        return _traders[seriesId][i];
    }

    // --- internal helpers ---

    function _join(uint256 seriesId, address trader) internal {
        if (!_isTrader[seriesId][trader]) {
            require(_traders[seriesId].length < MAX_TRADERS, "series full");
            _isTrader[seriesId][trader] = true;
            _traders[seriesId].push(trader);
        }
    }

    function _abs(int256 x) private pure returns (int256) {
        return x >= 0 ? x : -x;
    }

    /// @dev min(|a|, |b|) as a positive int — the "closed" quantity.
    function _absMin(int256 a, int256 b) private pure returns (int256) {
        int256 aa = _abs(a);
        int256 bb = _abs(b);
        return aa < bb ? aa : bb;
    }
}
