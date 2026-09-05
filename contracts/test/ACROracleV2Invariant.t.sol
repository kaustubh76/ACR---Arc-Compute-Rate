// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracleV2} from "../src/ACROracleV2.sol";

/// @dev Drives v2 with only *valid, properly-signed* posts: block time advances
///      before each post, the economic timestamp tracks it, and the window is
///      always a real span ending at the print. With `fail_on_revert = true`
///      this means the invariants below run against genuinely posted state
///      across every reachable sequence.
contract OracleV2Handler is Test {
    ACROracleV2 public oracle;
    bytes32 public constant INF = bytes32("ACR-INF");
    uint256 public signerPk;
    uint256 public posts;

    constructor(ACROracleV2 _oracle, uint256 _signerPk) {
        oracle = _oracle;
        signerPk = _signerPk;
    }

    function post(
        uint256 value,
        uint256 loSpread,
        uint256 hiSpread,
        uint256 bnd,
        uint256 humanMultiple,
        uint256 window,
        uint256 dt
    ) external {
        value = bound(value, 1, 1e30);
        loSpread = bound(loSpread, 0, value);
        hiSpread = bound(hiSpread, 0, 1e29);
        bnd = bound(bnd, 1, 1e12);
        // 0 exercises the "not computed" sentinel; anything else must sit at or
        // above the wallet bound, which is the rule the contract enforces.
        humanMultiple = bound(humanMultiple, 0, 5);
        window = bound(window, 1, uint256(oracle.MAX_WINDOW_SPAN()));
        dt = bound(dt, 1, 3600);

        vm.warp(block.timestamp + dt);
        uint64 ts = uint64(block.timestamp);
        // The window must fit below the timestamp; on the invariant runner's
        // clock that is not guaranteed, so clamp rather than skip — a skipped
        // call would quietly shrink the sequence space the invariants explore.
        if (window >= ts) window = 1;

        ACROracleV2.PrintInput memory p = ACROracleV2.PrintInput({
            indexId: INF,
            value: value,
            ciLo: value - loSpread,
            ciHi: value + hiSpread,
            attackCostPerBp: bnd,
            timestamp: ts,
            humanAdjustedBound: humanMultiple == 0 ? 0 : bnd * humanMultiple,
            policyHash: keccak256(abi.encode("policy", window)),
            windowStart: uint64(ts - window),
            windowEnd: ts
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        oracle.postPrint(p, v, r, s);
        posts++;
    }
}

contract ACROracleV2InvariantTest is Test {
    ACROracleV2 oracle;
    OracleV2Handler handler;
    bytes32 constant INF = bytes32("ACR-INF");

    function setUp() public {
        // A real epoch clock: v2's window rules are only meaningfully reachable
        // when a month fits below the timestamp.
        vm.warp(1_785_000_000);
        oracle = new ACROracleV2();
        uint256 signerPk = 0xA11CE;
        handler = new OracleV2Handler(oracle, signerPk);
        oracle.setSigner(vm.addr(signerPk), true);
        targetContract(address(handler));
    }

    /// Invariant 1: the latest print's value always lies within its CI.
    function invariant_ValueWithinCI() public view {
        if (oracle.historyLength(INF) == 0) return;
        ACROracleV2.Print memory p = oracle.latestPrint(INF);
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

    /// Invariant 6 (v2): every stored print names a cleaning policy.
    ///
    /// The one that makes the print reproducible. A stored print with a zero
    /// policy hash would be a published number nobody could re-derive — the
    /// exact objection the field exists to answer.
    function invariant_EveryPrintNamesAPolicy() public view {
        uint256 n = oracle.historyLength(INF);
        for (uint256 i = 0; i < n; i++) {
            assertTrue(oracle.historyAt(INF, i).policyHash != bytes32(0), "print with no policy");
        }
    }

    /// Invariant 7 (v2): every stored window is a real span ending at or before
    /// the print it belongs to — never inverted, never empty, never in the
    /// future.
    function invariant_WindowsAreWellFormed() public view {
        uint256 n = oracle.historyLength(INF);
        for (uint256 i = 0; i < n; i++) {
            ACROracleV2.Print memory p = oracle.historyAt(INF, i);
            assertLt(p.windowStart, p.windowEnd, "window inverted or empty");
            assertLe(p.windowEnd, p.timestamp, "window ends after the print");
            assertLe(
                uint256(p.windowEnd - p.windowStart),
                uint256(oracle.MAX_WINDOW_SPAN()),
                "window wider than the maximum"
            );
        }
    }

    /// Invariant 8 (v2): a human-denominated bound is never cheaper than the
    /// wallet-denominated one. Zero is the "not computed" sentinel and is
    /// allowed; anything between zero and the wallet bound would understate the
    /// cost of moving the index.
    function invariant_HumanBoundNeverUndercutsWalletBound() public view {
        uint256 n = oracle.historyLength(INF);
        for (uint256 i = 0; i < n; i++) {
            ACROracleV2.Print memory p = oracle.historyAt(INF, i);
            if (p.humanAdjustedBound == 0) continue;
            assertGe(p.humanAdjustedBound, p.attackCostPerBp, "human bound undercuts wallet bound");
        }
    }
}
