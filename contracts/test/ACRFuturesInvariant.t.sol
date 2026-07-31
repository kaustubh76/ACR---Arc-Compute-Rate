// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracle} from "../src/ACROracle.sol";
import {ACRFutures} from "../src/ACRFutures.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice The handler only ever makes VALID calls (foundry.toml runs invariants
///         with fail_on_revert=true) — it clamps every trade so margin always
///         holds — so the invariants run against genuine traded state.
contract FuturesHandler is Test {
    ACROracle public oracle;
    ACRFutures public futures;
    MockUSDC public usdc;
    bytes32 public constant INF = bytes32("ACR-INF");
    uint256 public constant MULT = 1000;
    uint256 public constant MARGIN_BPS = 2000;
    uint256 signerPk = 0xA11CE;

    address public maker;
    address[] public takers;
    uint64 nextTs = 100;

    constructor() {
        vm.warp(1_000_000);
        oracle = new ACROracle();
        oracle.setSigner(vm.addr(signerPk), true);
        _postPrint(0.5e18);
        usdc = new MockUSDC();
        futures = new ACRFutures(address(oracle), address(usdc), MARGIN_BPS);
        maker = makeAddr("maker");
        futures.openSeries(INF, uint64(block.timestamp + 3650 days), MULT, maker); // far expiry: never settles
        _fund(maker, 1_000_000e6);
        for (uint256 i = 0; i < 4; i++) {
            address t = makeAddr(string(abi.encodePacked("taker", i)));
            takers.push(t);
            _fund(t, 1_000_000e6);
        }
    }

    function _postPrint(uint256 value) internal {
        nextTs += 1;
        uint256 lo = value * 90 / 100;
        uint256 hi = value * 110 / 100;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerPk, oracle.printDigest(INF, value, lo, hi, 1000e6, nextTs));
        oracle.postPrint(INF, value, lo, hi, 1000e6, nextTs, v, r, s);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(futures), type(uint256).max);
        vm.prank(who);
        futures.postCollateral(0, amount);
    }

    /// @dev A bounded, always-valid trade: pick a taker, clamp |qty| so the
    ///      resulting notional stays well inside both sides' collateral.
    function trade(uint256 who, int256 qty) external {
        address t = takers[who % takers.length];
        // With ≥1e6 USDC collateral each side, 20% margin, mark ~0.5, mult 1000,
        // a |qty| ≤ 100 contracts needs ≤ 10k margin — always safe.
        int256 q = qty % 100e18;
        if (q == 0) q = 1e18;
        vm.prank(t);
        futures.trade(0, q);
    }

    /// @dev Occasionally move the mark so positions carry real MtM.
    function repriceMark(uint256 seed) external {
        uint256 value = 0.3e18 + (seed % 40) * 0.01e18; // 0.30 .. 0.69
        _postPrint(value);
    }

    function takerCount() external view returns (uint256) {
        return takers.length;
    }
}

contract ACRFuturesInvariantTest is Test {
    FuturesHandler handler;

    function setUp() public {
        handler = new FuturesHandler();
        targetContract(address(handler));
    }

    /// @notice Every taker fill is mirrored by the maker, so the net open
    ///         interest across all participants is always exactly zero.
    function invariant_netContractsZero() public view {
        ACRFutures f = handler.futures();
        int256 net = f.positionOf(0, handler.maker()).contracts;
        uint256 n = handler.takerCount();
        for (uint256 i = 0; i < n; i++) {
            net += f.positionOf(0, handler.takers(i)).contracts;
        }
        assertEq(net, int256(0), "net open interest must be zero");
    }

    /// @notice The contract never holds less USDC than the collateral it owes —
    ///         collateral is only ever moved between accounts, never minted.
    function invariant_collateralBackedByBalance() public view {
        ACRFutures f = handler.futures();
        MockUSDC usdc = handler.usdc();
        uint256 owed = f.collateral(0, handler.maker());
        uint256 n = handler.takerCount();
        for (uint256 i = 0; i < n; i++) {
            owed += f.collateral(0, handler.takers(i));
        }
        assertLe(owed, usdc.balanceOf(address(f)), "collateral must be fully backed");
    }
}
