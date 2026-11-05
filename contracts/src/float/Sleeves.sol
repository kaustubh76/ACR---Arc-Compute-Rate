// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, IERC4626, ISleeve} from "./IFloat.sol";

/// @title Erc4626Sleeve — idle float parked in a real yield vault.
/// @notice On Arc Testnet this points at the Morpho Vault V2 that Circle's Earn
///         Kit discovers (`0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88`): a real
///         ERC-4626 USDC vault, zero management and performance fee, and
///         permissionless — all four of Vault V2's transfer gates are the zero
///         address, which is why a CONTRACT may hold shares here at all. That
///         last fact is what makes the just-in-time path possible in Solidity
///         instead of as two transactions narrated as one.
///
/// @dev    TWO PROPERTIES OF THAT VAULT BREAK ORDINARY 4626 CODE, and both are
///         handled here rather than left for the caller:
///
///         1. `maxWithdraw`/`maxDeposit`/`maxMint`/`maxRedeem` ALWAYS RETURN
///            ZERO on Vault V2, by design and stated in its own source. Sizing a
///            withdrawal from `maxWithdraw` — which is the obvious way to write
///            `valueUsdc` and the way our own design notes first wrote it —
///            reports an empty sleeve forever. `valueUsdc` therefore converts the
///            share balance, which is the only honest reading.
///
///         2. SHARES ARE 18 DECIMALS AGAINST 6-DECIMAL USDC (`virtualShares` is
///            1e12). So `convertToAssets` must be fed a SHARE balance and never
///            an asset amount: `convertToAssets(1e6)` returns zero, and a sleeve
///            that believed it would report 1 USDC as nothing.
///
///         The sleeve holds the shares, not the vault, so the treasury's
///         accounting stays one hop from the yield venue and a venue change is a
///         new sleeve rather than a migration.
contract Erc4626Sleeve is ISleeve {
    IERC4626 public immutable venue;
    IERC20 public immutable usdc;
    address public immutable treasury;

    event Parked(uint256 usdcAmount);
    event Pulled(uint256 usdcRequested, uint256 usdcDelivered);

    /// @param venue_ the ERC-4626 USDC vault
    /// @param usdc_ the asset
    /// @param treasury_ the only address allowed to move this sleeve, and the
    ///        address withdrawals are delivered to
    constructor(address venue_, address usdc_, address treasury_) {
        require(venue_ != address(0) && usdc_ != address(0) && treasury_ != address(0), "zero arg");
        // If the venue's asset is not our USDC, every later number is a lie.
        // Checked once, here, rather than discovered by a deposit that vanishes.
        require(IERC4626(venue_).asset() == usdc_, "venue asset mismatch");
        venue = IERC4626(venue_);
        usdc = IERC20(usdc_);
        treasury = treasury_;
    }

    modifier onlyTreasury() {
        require(msg.sender == treasury, "not treasury");
        _;
    }

    function depositIdle(uint256 usdcAmount) external onlyTreasury {
        require(usdcAmount > 0, "zero amount");
        require(usdc.transferFrom(treasury, address(this), usdcAmount), "pull failed");
        require(usdc.approve(address(venue), usdcAmount), "approve failed");
        venue.deposit(usdcAmount, address(this));
        emit Parked(usdcAmount);
    }

    /// @notice Pull `usdcAmount` back to the treasury.
    /// @dev    Delivers straight to the treasury, so the just-in-time path is one
    ///         hop and the explorer's internal-call list reads in the order the
    ///         story is told: price read, sleeve withdraw, seller paid.
    ///
    ///         Rounding is NOT papered over here. A share-priced vault can
    ///         deliver a wei less than asked, and the treasury measures its own
    ///         balance delta rather than trusting this call, so a short delivery
    ///         is caught with a reason a human can read instead of surfacing as
    ///         a failed token transfer after the yield position was already
    ///         unwound. The event records both numbers for the same reason.
    function withdrawExact(uint256 usdcAmount) external onlyTreasury {
        require(usdcAmount > 0, "zero amount");
        uint256 before = usdc.balanceOf(treasury);
        venue.withdraw(usdcAmount, treasury, address(this));
        emit Pulled(usdcAmount, usdc.balanceOf(treasury) - before);
    }

    function valueUsdc() external view returns (uint256) {
        uint256 shares = venue.balanceOf(address(this));
        if (shares == 0) return 0;
        return venue.convertToAssets(shares);
    }
}

/// @title NullSleeve — a sleeve that holds nothing and says so.
/// @notice For the reserve position before a second venue exists, and for tests
///         that need a sleeve which cannot pay. It reports zero value and
///         REFUSES both verbs rather than accepting a deposit it would not be
///         able to return. A no-op `depositIdle` would swallow the treasury's
///         excess into a contract with no way out, which is worse than a revert.
/// @dev    The treasury treats a zero-address reserve as "no reserve" and skips
///         it, so this contract is not needed in production — it exists to make
///         the refusal explicit where a sleeve IS wired but inert.
contract NullSleeve is ISleeve {
    function depositIdle(uint256) external pure {
        revert("sleeve inactive");
    }

    function withdrawExact(uint256) external pure {
        revert("sleeve inactive");
    }

    function valueUsdc() external pure returns (uint256) {
        return 0;
    }
}
