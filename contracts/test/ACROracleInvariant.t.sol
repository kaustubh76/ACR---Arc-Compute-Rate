// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracle} from "../src/ACROracle.sol";

/// @dev Drives the oracle with only *valid, properly-signed* posts: block time
///      advances before each post, the economic timestamp tracks it (so the
///      skew + monotonicity rules always pass), and every field is in range.
///      With `fail_on_revert = true` this means the invariants below run against
///      genuinely posted state across every reachable sequence.
contract OracleHandler is Test {
    ACROracle public oracle;
    bytes32 public constant INF = bytes32("ACR-INF");
    uint256 public signerPk;
    uint256 public posts;

    constructor(ACROracle _oracle, uint256 _signerPk) {
        oracle = _oracle;
        signerPk = _signerPk;
    }

    function post(uint256 value, uint256 loSpread, uint256 hiSpread, uint256 bnd, uint256 dt)
        external
    {
        value = bound(value, 1, 1e30);
        loSpread = bound(loSpread, 0, value); // ciLo in [0, value]
        hiSpread = bound(hiSpread, 0, 1e29);
        bnd = bound(bnd, 1, 1e12); // fuzz the attack bound (was hardcoded to 1)
        dt = bound(dt, 1, 3600);

        vm.warp(block.timestamp + dt);
        uint64 ts = uint64(block.timestamp); // == block time: passes skew + monotone

        uint256 lo = value - loSpread;
        uint256 hi = value + hiSpread;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(INF, value, lo, hi, bnd, ts));
        oracle.postPrint(INF, value, lo, hi, bnd, ts, v, r, s);
        posts++;
    }
}

contract ACROracleInvariantTest is Test {
    ACROracle oracle;
    OracleHandler handler;
    bytes32 constant INF = bytes32("ACR-INF");

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new ACROracle();
        uint256 signerPk = 0xA11CE;
        handler = new OracleHandler(oracle, signerPk);
        oracle.setSigner(vm.addr(signerPk), true);
        targetContract(address(handler));
    }

    /// Invariant 1: the latest print's value always lies within its CI.
    function invariant_ValueWithinCI() public view {
        if (oracle.historyLength(INF) == 0) return;
        ACROracle.Print memory p = oracle.latestPrint(INF);
        assertTrue(p.ciLo <= p.value && p.value <= p.ciHi, "value escaped CI");
    }

    /// Invariant 2: economic timestamps are strictly monotone across history.
    function invariant_MonotoneTimestamps() public view {
        uint256 n = oracle.historyLength(INF);
        if (n < 2) return;
        for (uint256 i = 1; i < n; i++) {
            assertGt(
                oracle.historyAt(INF, i).timestamp,
                oracle.historyAt(INF, i - 1).timestamp,
                "timestamps not monotone"
            );
        }
    }

    /// Invariant 3: every stored print carries a strictly positive attack bound.
    function invariant_BoundSanity() public view {
        uint256 n = oracle.historyLength(INF);
        for (uint256 i = 0; i < n; i++) {
            assertGt(oracle.historyAt(INF, i).attackCostPerBp, 0, "bound=0 stored");
        }
    }

    /// Invariant 4: posting timestamps (staleness anchors) never go backwards.
    function invariant_PostedAtNonDecreasing() public view {
        uint256 n = oracle.historyLength(INF);
        if (n < 2) return;
        for (uint256 i = 1; i < n; i++) {
            assertGe(
                oracle.historyAt(INF, i).postedAt,
                oracle.historyAt(INF, i - 1).postedAt,
                "postedAt regressed"
            );
        }
    }

    /// Invariant 5: latest mirrors the tail of history.
    function invariant_LatestMatchesHistoryTail() public view {
        uint256 n = oracle.historyLength(INF);
        if (n == 0) return;
        assertEq(oracle.latestPrint(INF).timestamp, oracle.historyAt(INF, n - 1).timestamp);
    }
}
