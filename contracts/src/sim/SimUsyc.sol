// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../float/IFloat.sol";

// A STAND-IN, AND NAMED ONE ON PURPOSE.
//
// These two are deployed to Arc Testnet so the USYC reserve leg can be shown
// working during the event. They are NOT Circle's contracts and they hold no
// real fund. The real Teller is 0x9fdF14c5B14173D74C08Af27AebFf39240dC105A and
// it refuses us: a staticcall of its `deposit` reverts 0x7f63bd0f, which its
// verified ABI names NotPermissioned(). Allowlisting is a support ticket with a
// 24-48 hour turnaround, which is why this exists.
//
// They live in `src/sim/` rather than `test/` because they LEAVE THE MACHINE,
// and a deployed contract shows its name on the explorer. `SimUsycTeller`
// cannot be mistaken for the real one at a glance; `MockUsycTeller` sitting on
// a public chain would be a worse label and a `test/` path would be a lie
// about where it runs.
//
// The sleeve in front of them is the REAL `UsycSleeve`, unchanged. When the
// allowlist lands, one constructor argument changes and nothing else does.
// `contracts/script/DeployFloat.s.sol` keeps the production vault's reserve at
// address(0) on purpose, and this does not alter that: the sleeve deployed here
// answers to the deployer, not to the treasury, so no invented number can reach
// `totalValueUsdc()`.

/// @notice A 6-decimal share token the Teller double can mint and burn freely.
/// @dev    Deliberately unguarded: this is a fixture, and adding a minter role
///         would test the fixture rather than the sleeve.
contract SimUsyc is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function burn(address from, uint256 a) external {
        require(balanceOf[from] >= a, "burn exceeds balance");
        balanceOf[from] -= a;
    }

    function approve(address spender, uint256 a) external returns (bool) {
        allowance[msg.sender][spender] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "insufficient");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        require(balanceOf[from] >= a, "insufficient");
        balanceOf[from] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @notice Circle's USYC Teller, modelled on the VERIFIED implementation.
/// @dev    Shapes taken from the ABI behind the EIP-1967 proxy on Arc Testnet
///         (`0x238dc235…adf6`), not invented: `deposit(uint256,address)`,
///         `redeem(uint256,address,address)`, `previewDeposit`,
///         `previewRedeem`, `maxDeposit(address)`, and the custom error
///         `NotPermissioned()` whose selector `0x7f63bd0f` is what our own
///         deployer gets today.
///
///         `maxDeposit` REPRODUCES THE TRAP ON PURPOSE. The live Teller returns
///         a non-zero number for an address it will not let deposit — ours read
///         5,723,443 while `deposit` reverted `NotPermissioned()`. A double
///         that returned 0 when un-permissioned would quietly teach the wrong
///         eligibility check, which is the mistake this fixture exists to make
///         impossible to repeat.
contract SimUsycTeller {
    error NotPermissioned();

    IERC20 public immutable usdcToken;
    SimUsyc public immutable usycToken;

    /// 18-decimal USDC per USYC. The live Teller read 1.142776 on 2026-11-06.
    uint256 public nav = 1_142_775_997_364_038_969;
    /// Basis points taken on the way out, so `previewRedeem` is net.
    uint256 public redemptionFeeBps;
    bool public permissioned;

    constructor(IERC20 usdc_, SimUsyc usyc_) {
        usdcToken = usdc_;
        usycToken = usyc_;
    }

    function setPermissioned(bool v) external {
        permissioned = v;
    }

    function setNav(uint256 v) external {
        nav = v;
    }

    function setRedemptionFeeBps(uint256 v) external {
        redemptionFeeBps = v;
    }

    /// Non-zero regardless of permission — the trap, faithfully.
    function maxDeposit(address) external pure returns (uint256) {
        return 5_723_443;
    }

    function previewDeposit(uint256 usdcAmount) public view returns (uint256) {
        return usdcAmount * 1e18 / nav;
    }

    function previewRedeem(uint256 usycAmount) public view returns (uint256) {
        uint256 gross = usycAmount * nav / 1e18;
        return gross - (gross * redemptionFeeBps / 10_000);
    }

    function deposit(uint256 usdcAmount, address receiver) external returns (uint256 shares) {
        if (!permissioned) revert NotPermissioned();
        require(usdcToken.transferFrom(msg.sender, address(this), usdcAmount), "pull failed");
        shares = previewDeposit(usdcAmount);
        usycToken.mint(receiver, shares);
    }

    function redeem(uint256 usycAmount, address usdcReceiver, address usycAccount)
        external
        returns (uint256 assets)
    {
        if (!permissioned) revert NotPermissioned();
        assets = previewRedeem(usycAmount);
        usycToken.burn(usycAccount, usycAmount);
        require(usdcToken.transfer(usdcReceiver, assets), "transfer failed");
    }
}
