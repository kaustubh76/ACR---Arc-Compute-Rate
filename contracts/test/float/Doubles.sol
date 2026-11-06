// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, ISleeve} from "../../src/float/IFloat.sol";
import {MockUSDC} from "../MockUSDC.sol";

/// @notice An ERC-4626 vault that behaves like the one Float actually points at.
/// @dev    Reproduces the two Morpho Vault V2 properties that break ordinary
///         4626 code, so the sleeve is tested against the real hazard rather
///         than a friendlier fiction:
///
///         1. `maxWithdraw`/`maxDeposit`/`maxMint`/`maxRedeem` RETURN ZERO. They
///            exist here only so that a sleeve which reached for them would read
///            an empty vault and fail its tests immediately.
///         2. SHARES ARE 18 DECIMALS against the 6-decimal asset.
///
///         `accrue` raises the share price the way real yield does, so a
///         withdrawal after accrual exercises the rounding the vault has to
///         survive.
contract MockVault4626 {
    MockUSDC public immutable usdcToken;
    uint256 public totalShares;
    uint256 public totalAssets;
    mapping(address => uint256) public balanceOf;

    constructor(MockUSDC usdc_) {
        usdcToken = usdc_;
    }

    function asset() external view returns (address) {
        return address(usdcToken);
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    // The quirk, on purpose.
    function maxWithdraw(address) external pure returns (uint256) {
        return 0;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return 0;
    }

    function maxMint(address) external pure returns (uint256) {
        return 0;
    }

    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return shares / 1e12;
        return shares * totalAssets / totalShares;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        if (totalAssets == 0) return assets * 1e12;
        // Round up: the vault must never burn too few shares for the assets out.
        return (assets * totalShares + totalAssets - 1) / totalAssets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(usdcToken.transferFrom(msg.sender, address(this), assets), "pull failed");
        shares = totalShares == 0 ? assets * 1e12 : assets * totalShares / totalAssets;
        totalShares += shares;
        totalAssets += assets;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        external
        returns (uint256 shares)
    {
        shares = previewWithdraw(assets);
        require(balanceOf[owner_] >= shares, "insufficient shares");
        balanceOf[owner_] -= shares;
        totalShares -= shares;
        totalAssets -= assets;
        require(usdcToken.transfer(receiver, assets), "transfer failed");
    }

    /// @notice Simulate yield: more assets behind the same shares.
    function accrue(uint256 extraAssets) external {
        usdcToken.mint(address(this), extraAssets);
        totalAssets += extraAssets;
    }
}

/// @notice A sleeve that records WHEN it was called relative to the payment.
/// @dev    Ordering inside a single transaction cannot be asserted from the
///         outside, so the sleeve snapshots the seller's balance at the moment
///         it is asked for money. If the withdrawal really precedes the payment,
///         that snapshot is zero while the final balance is the full quote —
///         which is the "the money was earning yield until the block it was
///         spent in" claim, mechanically.
contract RecordingSleeve is ISleeve {
    MockUSDC public immutable usdcToken;
    address public immutable treasury;
    address public watched;

    uint256 public lastRequested;
    uint256 public watchedBalanceAtWithdraw;
    uint256 public withdrawCalls;
    uint256 public depositCalls;

    constructor(MockUSDC usdc_, address treasury_) {
        usdcToken = usdc_;
        treasury = treasury_;
    }

    function watch(address who) external {
        watched = who;
    }

    function depositIdle(uint256 usdcAmount) external {
        depositCalls += 1;
        require(usdcToken.transferFrom(treasury, address(this), usdcAmount), "pull failed");
    }

    function withdrawExact(uint256 usdcAmount) external {
        withdrawCalls += 1;
        lastRequested = usdcAmount;
        watchedBalanceAtWithdraw = usdcToken.balanceOf(watched);
        require(usdcToken.transfer(treasury, usdcAmount), "transfer failed");
    }

    function valueUsdc() external view returns (uint256) {
        return usdcToken.balanceOf(address(this));
    }
}

/// @notice A sleeve that delivers one unit less than it was asked for.
/// @dev    Exactly the share-rounding failure a real vault can produce. The
///         treasury must catch it by measuring, and say so in words.
contract ShortSleeve is ISleeve {
    MockUSDC public immutable usdcToken;
    address public immutable treasury;

    constructor(MockUSDC usdc_, address treasury_) {
        usdcToken = usdc_;
        treasury = treasury_;
    }

    function depositIdle(uint256 usdcAmount) external {
        require(usdcToken.transferFrom(treasury, address(this), usdcAmount), "pull failed");
    }

    function withdrawExact(uint256 usdcAmount) external {
        require(usdcToken.transfer(treasury, usdcAmount - 1), "transfer failed");
    }

    function valueUsdc() external view returns (uint256) {
        return usdcToken.balanceOf(address(this));
    }
}

/// @notice A sleeve that tries to spend the treasury again while being drained.
/// @dev    The yield venue is the one external call in the spend path, so it is
///         the one place a re-entrant daily-cap bypass could live.
contract ReentrantSleeve is ISleeve {
    MockUSDC public immutable usdcToken;
    address public immutable treasury;
    bytes public payload;
    bool public tried;
    bool public succeeded;
    /// WHY the re-entry failed, not just that it did.
    ///
    /// This used to be discarded — `(succeeded,) = treasury.call(payload)` —
    /// and that single dropped return value is why the reentrancy test next
    /// door proved something other than its name for as long as it existed. A
    /// bare `assertFalse(succeeded)` is satisfied identically by "not executor"
    /// and by "reentrant", so it could not see which defence answered, and the
    /// re-entrant call was in fact being refused by the executor check before
    /// `nonReentrant` was ever consulted. Keeping the returndata is what makes
    /// the difference assertable.
    bytes public lastError;

    constructor(MockUSDC usdc_, address treasury_) {
        usdcToken = usdc_;
        treasury = treasury_;
    }

    function arm(bytes calldata payload_) external {
        payload = payload_;
    }

    function depositIdle(uint256 usdcAmount) external {
        require(usdcToken.transferFrom(treasury, address(this), usdcAmount), "pull failed");
    }

    function withdrawExact(uint256 usdcAmount) external {
        if (payload.length > 0 && !tried) {
            tried = true;
            (succeeded, lastError) = treasury.call(payload);
        }
        require(usdcToken.transfer(treasury, usdcAmount), "transfer failed");
    }

    /// @notice The revert string the re-entry came back with, or "" if it did
    ///         not revert with one.
    /// @dev    A `require(cond, "msg")` revert is `Error(string)`: the selector
    ///         `0x08c379a0` followed by an abi-encoded string. Anything else —
    ///         a custom error, a bare revert, an out-of-gas — has no string to
    ///         report, and returning "" for those is deliberate: a test that
    ///         asserts a specific message must FAIL when the revert is some
    ///         other kind, not quietly match on a decode that happened to
    ///         succeed.
    function lastErrorMessage() external view returns (string memory) {
        bytes memory e = lastError;
        if (e.length < 4) return "";
        if (e[0] != 0x08 || e[1] != 0xc3 || e[2] != 0x79 || e[3] != 0xa0) return "";
        bytes memory body = new bytes(e.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = e[i + 4];
        }
        return abi.decode(body, (string));
    }

    function valueUsdc() external view returns (uint256) {
        return usdcToken.balanceOf(address(this));
    }
}

/// @notice A sleeve that cannot pay out, the way a real venue cannot when its
///         gates close, its market is illiquid, or its caps bite.
/// @dev    This is the mode with no coverage at all before now, and it is the
///         one that matters most: `FloatVault` is built so a refusal RETURNS
///         FALSE and emits `Denied` rather than reverting — that is the whole
///         premise of the refusal ladder. A venue outage bypasses it. There is
///         no try/catch anywhere in `src/float`, so the revert propagates, the
///         payment dies with no `Denied` event, and on real Morpho V2 it
///         surfaces as a bare custom-error selector with nothing tying it to
///         the venue. It will look exactly like our bug and it is not one.
contract RevertingSleeve is ISleeve {
    MockUSDC public immutable usdcToken;
    uint256 public held;

    constructor(MockUSDC usdc_, uint256 held_) {
        usdcToken = usdc_;
        held = held_;
    }

    function depositIdle(uint256 usdcAmount) external {
        require(usdcToken.transferFrom(msg.sender, address(this), usdcAmount), "pull failed");
        held += usdcAmount;
    }

    /// Reports value it will not actually hand over, which is the honest shape
    /// of the hazard: `valueUsdc` reads a share balance, and shares are worth
    /// nothing you cannot redeem.
    function withdrawExact(uint256) external pure {
        revert("venue: withdraw gated");
    }

    function valueUsdc() external view returns (uint256) {
        return held;
    }
}

/// @notice An ERC-4626 that can be switched into the ways a venue misbehaves.
/// @dev    `MockVault4626` is a well-behaved vault with Morpho V2's two quirks.
///         This one adds the hazards nothing modelled before: a closed exit, a
///         deposit cap, and a deposit that takes the money and mints nothing.
///         Each is off by default so a test turns on exactly the one it is about.
contract GatedVault4626 {
    MockUSDC public immutable usdcToken;
    uint256 public totalShares;
    uint256 public totalAssets;
    mapping(address => uint256) public balanceOf;

    bool public withdrawGated;
    bool public mintZeroShares;
    uint256 public depositCap; // 0 = uncapped
    /// How much LESS than the approval this venue pulls. 0 = takes it all.
    ///
    /// The mode nothing could produce before: every deposit double in this
    /// file, plus `SimUsycTeller`, pulls the full `assets`, which consumes the
    /// whole allowance on its own. That made the obvious assertion about
    /// `Erc4626Sleeve`'s `approve(venue, 0)` reset VACUOUS — it held with the
    /// reset deleted. An under-pulling venue is the one case the reset was
    /// written for, and `Sleeves.sol:65-68` says so in as many words.
    uint256 public pullShortfall;

    constructor(MockUSDC usdc_) {
        usdcToken = usdc_;
    }

    function setWithdrawGated(bool v) external {
        withdrawGated = v;
    }

    function setMintZeroShares(bool v) external {
        mintZeroShares = v;
    }

    function setDepositCap(uint256 v) external {
        depositCap = v;
    }

    function setPullShortfall(uint256 v) external {
        pullShortfall = v;
    }

    function asset() external view returns (address) {
        return address(usdcToken);
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function maxWithdraw(address) external pure returns (uint256) {
        return 0;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return 0;
    }

    function maxMint(address) external pure returns (uint256) {
        return 0;
    }

    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return shares / 1e12;
        return shares * totalAssets / totalShares;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        if (totalAssets == 0) return assets * 1e12;
        return (assets * totalShares + totalAssets - 1) / totalAssets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(depositCap == 0 || totalAssets + assets <= depositCap, "venue: deposit cap");
        // The under-pulling mode: take less than the approval allows, and
        // credit only what was actually taken. With `pullShortfall` at its
        // default of zero this is byte-for-byte the old behaviour, so every
        // existing test reads the same.
        require(pullShortfall <= assets, "double misconfigured: shortfall > assets");
        uint256 taken = assets - pullShortfall;
        require(usdcToken.transferFrom(msg.sender, address(this), taken), "pull failed");
        // The silent-loss mode: the USDC is taken and no claim is issued.
        if (mintZeroShares) {
            totalAssets += taken;
            return 0;
        }
        shares = totalShares == 0 ? taken * 1e12 : taken * totalShares / totalAssets;
        totalShares += shares;
        totalAssets += taken;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        external
        returns (uint256 shares)
    {
        require(!withdrawGated, "venue: withdraw gated");
        shares = previewWithdraw(assets);
        require(balanceOf[owner_] >= shares, "insufficient shares");
        balanceOf[owner_] -= shares;
        totalShares -= shares;
        totalAssets -= assets;
        require(usdcToken.transfer(receiver, assets), "transfer failed");
    }

    function accrue(uint256 extraAssets) external {
        usdcToken.mint(address(this), extraAssets);
        totalAssets += extraAssets;
    }
}
