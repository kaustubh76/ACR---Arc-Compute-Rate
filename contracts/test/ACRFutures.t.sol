// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracle} from "../src/ACROracle.sol";
import {ACRFutures} from "../src/ACRFutures.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Unit tests for the on-chain cash-settled future. Settlement is tested
///         against a REAL ACROracle (signed prints), not a stub — the future's
///         whole point is that it resolves against the live reference feed.
contract ACRFuturesTest is Test {
    ACROracle oracle;
    ACRFutures futures;
    MockUSDC usdc;

    bytes32 constant INF = bytes32("ACR-INF");
    uint256 constant WAD = 1e18;
    uint256 constant MULT = 1000;
    uint256 constant MARGIN_BPS = 2000; // 20%

    uint256 signerPk = 0xA11CE;
    address signer;
    address maker;
    address alice;
    address bob;

    uint64 expiry;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new ACROracle();
        signer = vm.addr(signerPk);
        oracle.setSigner(signer, true);
        _postPrint(0.5e18, 100); // opening mark 0.50

        usdc = new MockUSDC();
        futures = new ACRFutures(address(oracle), address(usdc), MARGIN_BPS);

        maker = makeAddr("maker");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        expiry = uint64(block.timestamp + 7 days);
        futures.openSeries(INF, expiry, MULT, maker);

        address[3] memory actors = [maker, alice, bob];
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 10_000e6);
            vm.prank(actors[i]);
            usdc.approve(address(futures), type(uint256).max);
        }
        _post(maker, 2_000e6);
        _post(alice, 2_000e6);
        _post(bob, 2_000e6);
    }

    // --- helpers ---

    function _postPrint(uint256 value, uint64 ts) internal {
        uint256 lo = value * 96 / 100;
        uint256 hi = value * 104 / 100;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerPk, oracle.printDigest(INF, value, lo, hi, 1000e6, ts));
        oracle.postPrint(INF, value, lo, hi, 1000e6, ts, v, r, s);
    }

    function _post(address who, uint256 amount) internal {
        vm.prank(who);
        futures.postCollateral(0, amount);
    }

    function _trade(address who, int256 qty) internal {
        vm.prank(who);
        futures.trade(0, qty);
    }

    // --- series lifecycle ---

    function test_OpenSeries_RequiresOraclePrint() public {
        ACRFutures f2 = new ACRFutures(address(oracle), address(usdc), MARGIN_BPS);
        vm.expectRevert("no print"); // ACR-GPU was never printed
        f2.openSeries(bytes32("ACR-GPU"), uint64(block.timestamp + 1 days), MULT, maker);
    }

    function test_OpenSeries_RevertPastExpiry() public {
        vm.expectRevert("expiry in past");
        futures.openSeries(INF, uint64(block.timestamp - 1), MULT, maker);
    }

    // --- collateral ---

    function test_PostCollateral_MovesUsdc() public {
        assertEq(futures.collateral(0, alice), 2_000e6);
        assertEq(usdc.balanceOf(address(futures)), 6_000e6); // maker + alice + bob
    }

    function test_WithdrawFreeCollateral() public {
        vm.prank(alice);
        futures.withdrawCollateral(0, 500e6);
        assertEq(futures.collateral(0, alice), 1_500e6);
    }

    function test_WithdrawBlockedBelowMargin() public {
        _trade(alice, 2e18); // 2 contracts @0.50 = 1000 notional, 200 margin
        vm.prank(alice);
        vm.expectRevert("below margin");
        futures.withdrawCollateral(0, 1_900e6); // would leave 100 < 200 margin
    }

    // --- trading ---

    function test_MakerCannotTake() public {
        vm.prank(maker);
        vm.expectRevert("maker cannot take");
        futures.trade(0, 1e18);
    }

    function test_Trade_MakerTakesMirror() public {
        _trade(alice, 3e18);
        assertEq(futures.positionOf(0, alice).contracts, int256(3e18));
        assertEq(futures.positionOf(0, maker).contracts, int256(-3e18)); // exact mirror
    }

    function test_Trade_MarginRefusal() public {
        // bob has 2_000e6. A 25-contract long @0.50 = 12_500 notional, 2_500 margin > 2_000.
        vm.prank(bob);
        vm.expectRevert("taker margin");
        futures.trade(0, 25e18);
    }

    function test_PositionMath_ReduceThenFlip() public {
        _trade(alice, 2e18); // +2 @0.50
        _postPrint(0.6e18, 200); // mark moves to 0.60
        _trade(alice, -3e18); // sell 3 → flip to -1, realize the closed 2

        ACRFutures.Position memory p = futures.positionOf(0, alice);
        assertEq(p.contracts, int256(-1e18), "flipped to -1");
        assertEq(p.avgPrice, int256(0.6e18), "avg resets to fill on flip");
        // closed 2 contracts from 0.50 -> 0.60 = 2 * 0.10 = 0.20 WAD value*contracts
        assertEq(p.realizedPnl, int256(0.2e18), "realized on the closed leg");
    }

    // --- settlement ---

    function test_Settle_LongProfitZeroSum() public {
        _trade(alice, 2e18); // alice long 2, maker short 2
        uint256 potBefore = usdc.balanceOf(address(futures));

        vm.warp(expiry + 60);
        _postPrint(0.6e18, uint64(expiry)); // settle mark 0.60 (index rose 0.10)
        futures.settle(0);

        // alice long 2 * 0.10 * 1000 = +200 USDC; maker mirror -200.
        assertEq(futures.collateral(0, alice), 2_200e6, "alice +200");
        assertEq(futures.collateral(0, maker), 1_800e6, "maker -200");
        assertEq(futures.collateral(0, bob), 2_000e6, "bob untouched");
        assertEq(usdc.balanceOf(address(futures)), potBefore, "pot conserved");
        // positions flattened
        assertEq(futures.positionOf(0, alice).contracts, int256(0));
    }

    function test_Settle_WinnersWithdrawRealCash() public {
        _trade(alice, 2e18);
        vm.warp(expiry + 60);
        _postPrint(0.6e18, uint64(expiry));
        futures.settle(0);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        futures.withdrawCollateral(0, 2_200e6);
        assertEq(usdc.balanceOf(alice) - before, 2_200e6, "cash actually paid out");
    }

    function test_Settle_RevertBeforeExpiry() public {
        _trade(alice, 1e18);
        vm.expectRevert("not expired");
        futures.settle(0);
    }

    function test_Settle_FreshnessGuardReverts() public {
        _trade(alice, 1e18);
        vm.warp(expiry + 60);
        _postPrint(0.6e18, uint64(expiry)); // fresh at this instant
        // ...but let it go stale beyond MAX_SETTLE_AGE with no new print
        vm.warp(block.timestamp + futures.MAX_SETTLE_AGE() + 1);
        vm.expectRevert("stale print");
        futures.settle(0);
    }

    function test_Settle_DoubleSettleReverts() public {
        _trade(alice, 1e18);
        vm.warp(expiry + 60);
        _postPrint(0.6e18, uint64(expiry));
        futures.settle(0);
        vm.expectRevert("already settled");
        futures.settle(0);
    }

    /// @notice Cross-implementation parity: this exact fill vector must produce
    ///         the SAME (contracts, avgPrice, realizedPnl) as
    ///         `acr_instrument.future.Position` — see the twin test
    ///         `packages/acr_instrument/tests/test_parity_onchain.py`. Fills are
    ///         driven through `trade()` by repricing the oracle before each step.
    function test_Parity_MatchesPythonPosition() public {
        uint64 ts = 200;
        // (qty contracts, mark) — clean divisions so float vs int agree exactly.
        int256[4] memory qtys = [int256(2e18), int256(2e18), int256(-1e18), int256(-5e18)];
        uint256[4] memory marks = [uint256(0.5e18), 0.6e18, 0.7e18, 0.4e18];
        for (uint256 i = 0; i < 4; i++) {
            _postPrint(marks[i], ts);
            ts += 10;
            _trade(alice, qtys[i]);
        }
        ACRFutures.Position memory p = futures.positionOf(0, alice);
        assertEq(p.contracts, int256(-2e18), "contracts");
        assertEq(p.avgPrice, int256(0.4e18), "avgPrice");
        assertEq(p.realizedPnl, int256(-0.3e18), "realizedPnl");
    }

    function test_Settle_SocializedLossOnInsolventShort() public {
        // Alice shorts hard, price rips up past her collateral → her loss is
        // capped at her posted collateral and the maker (winner) is haircut so
        // the pot still balances exactly (no mint, no underflow).
        _trade(alice, -10e18); // short 10 @0.50 = 5000 notional, 1000 margin (ok, 2000 posted)
        vm.warp(expiry + 60);
        _postPrint(1.0e18, uint64(expiry)); // price doubles: short loses 10*0.50*1000 = 5000 > 2000
        uint256 pot = usdc.balanceOf(address(futures));
        futures.settle(0);

        assertEq(futures.collateral(0, alice), 0, "insolvent short floored to zero");
        uint256 total = futures.collateral(0, alice) + futures.collateral(0, maker)
            + futures.collateral(0, bob);
        assertLe(total, pot, "never distributes more than the pot");
        assertGe(total + 3, pot, "conserves the pot up to integer dust");
    }
}
