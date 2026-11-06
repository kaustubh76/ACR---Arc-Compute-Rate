// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, ISleeve} from "./IFloat.sol";

/// @notice The USYC Teller, as the VERIFIED implementation declares it.
/// @dev    Read on 2026-11-06 from the implementation behind the EIP-1967 proxy
///         at `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` on Arc Testnet —
///         Blockscout had not resolved the proxy, so the ABI came from slot
///         `0x3608…2bbc` -> `0x238dc235…adf6`, which is verified and declares
///         60 functions. Nothing here is guessed.
///
///         `docs/TAMEION.md` said the real ABI was needed and that guessing at
///         it would be worse than saying so. This is that ABI.
interface IUsycTeller {
    /// @param usdcAmount assets in, @param receiver who gets the USYC.
    function deposit(uint256 usdcAmount, address receiver) external returns (uint256);
    /// @param usycAmount shares in, @param usdcReceiver who gets the USDC,
    ///        @param usycAccount whose USYC is burned.
    function redeem(uint256 usycAmount, address usdcReceiver, address usycAccount)
        external
        returns (uint256);
    /// USDC out for USYC in, net of this caller's redemption fee.
    function previewRedeem(uint256 usycAmount) external view returns (uint256);
    /// USYC out for USDC in, net of this caller's subscription fee.
    function previewDeposit(uint256 usdcAmount) external view returns (uint256);
}

/// @title UsycSleeve — idle float parked in Circle's tokenised treasury fund.
///
/// @notice The reserve leg the original design called for and never had. The
///         working sleeve (`Erc4626Sleeve`) sits in a Morpho vault and is the
///         one the just-in-time pull hits first; this one is slower money,
///         reached only when working cannot cover a payment.
///
/// @dev    THIS CONTRACT IS DEPLOYABLE BUT NOT YET FUNDABLE, and that is a
///         property of Circle's allowlist rather than of this code. Verified
///         on Arc Testnet the same day this was written: a staticcall of
///         `deposit` from our deployer reverts `0x7f63bd0f`, which the Teller's
///         verified ABI names `NotPermissioned()`. Allowlisting is a support
///         ticket with a 24-48 hour turnaround, and THIS SLEEVE is the address
///         that must be on the list — not the treasury, which never holds USYC
///         under this design.
///
///         A TRAP, recorded because it would send the next person the wrong
///         way: `maxDeposit(address)` returns a NON-ZERO number for an address
///         that is `NotPermissioned()`. Ours read 5,723,443 while deposits
///         reverted. `maxDeposit > 0` is therefore NOT an eligibility check.
///         The honest probe is a staticcall of `deposit` itself, which is what
///         the acceptance suite does.
///
///         TWO DEPARTURES FROM THE ORIGINAL SKETCH, both because the real ABI
///         turned out to be better than the one assumed:
///
///         1. NO ORACLE. The sketch carried an `IPrices usycOracle` to price
///            USYC into USDC. The Teller previews its own redemption, so the
///            price comes from the counterparty that will honour it, net of
///            the fee it will actually charge. An oracle here would add a
///            trusted third party and a staleness window to a number the
///            Teller already publishes.
///         2. SIZED BY PREVIEW, NOT BY DIVISION. `withdrawExact` scales the
///            share balance against the previewed whole-position value rather
///            than dividing by a NAV, so the Teller's own fee and rounding are
///            inside the estimate instead of being corrected for afterwards.
contract UsycSleeve is ISleeve {
    IUsycTeller public immutable teller;
    IERC20 public immutable usdc;
    IERC20 public immutable usyc;
    address public immutable treasury;

    event Parked(uint256 usdcAmount);
    event Pulled(uint256 usdcRequested, uint256 usdcDelivered);

    constructor(address teller_, address usdc_, address usyc_, address treasury_) {
        require(
            teller_ != address(0) && usdc_ != address(0) && usyc_ != address(0)
                && treasury_ != address(0),
            "zero arg"
        );
        teller = IUsycTeller(teller_);
        usdc = IERC20(usdc_);
        usyc = IERC20(usyc_);
        treasury = treasury_;
    }

    modifier onlyTreasury() {
        require(msg.sender == treasury, "not treasury");
        _;
    }

    /// @notice Buy USYC with idle USDC.
    /// @dev    Same approval hygiene as `Erc4626Sleeve`: approve exactly, then
    ///         clear. A Teller that pulls less than it was approved for would
    ///         otherwise leave a standing allowance against this sleeve's
    ///         balance, which is a permission nobody granted on purpose.
    function depositIdle(uint256 usdcAmount) external onlyTreasury {
        require(usdcAmount > 0, "zero amount");
        require(usdc.transferFrom(treasury, address(this), usdcAmount), "pull failed");
        require(usdc.approve(address(teller), usdcAmount), "approve failed");
        teller.deposit(usdcAmount, address(this));
        require(usdc.approve(address(teller), 0), "approve reset failed");
        emit Parked(usdcAmount);
    }

    /// @notice Redeem enough USYC to put `usdcAmount` in the treasury.
    ///
    /// @dev    MEASURE, DO NOT ASSUME — the same contract `Erc4626Sleeve` makes
    ///         and for the same reason. The treasury's balance delta is the
    ///         number recorded, so a Teller that delivers less than previewed
    ///         is caught upstairs by name instead of surfacing as a failed
    ///         transfer after the position was already unwound.
    ///
    ///         The redemption is sized by scaling the share balance against the
    ///         previewed value of the WHOLE position, rounded up, with one unit
    ///         of headroom where the balance allows it. Redeeming a share too
    ///         many leaves dust in the buffer; redeeming one too few fails a
    ///         payment that should have cleared, so the rounding goes the way
    ///         that cannot refuse a correct payment.
    function withdrawExact(uint256 usdcAmount) external onlyTreasury {
        require(usdcAmount > 0, "zero amount");

        uint256 shares = usyc.balanceOf(address(this));
        require(shares > 0, "sleeve holds nothing");

        uint256 whole = teller.previewRedeem(shares);
        require(whole >= usdcAmount, "sleeve cannot cover this");

        // Ceiling division against the previewed whole, so the estimate never
        // rounds down into a short delivery.
        uint256 toRedeem = (shares * usdcAmount + whole - 1) / whole;
        if (toRedeem < shares) toRedeem += 1; // headroom, where there is room
        if (toRedeem > shares) toRedeem = shares;

        uint256 before = usdc.balanceOf(treasury);
        teller.redeem(toRedeem, treasury, address(this));
        emit Pulled(usdcAmount, usdc.balanceOf(treasury) - before);
    }

    /// @notice What the position is worth ON EXIT, which is the only number the
    ///         treasury can spend.
    /// @dev    `previewRedeem` is net of the Teller's redemption fee for this
    ///         address, so this is deliberately not `balance * NAV`: a fee that
    ///         the fund will certainly charge is not value the treasury has.
    function valueUsdc() external view returns (uint256) {
        uint256 shares = usyc.balanceOf(address(this));
        if (shares == 0) return 0;
        return teller.previewRedeem(shares);
    }
}
