// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracleV2} from "../src/ACROracleV2.sol";

/// v2 carries the four facts that turn a published print into a reproducible
/// one. v1's guarantees are re-asserted here rather than assumed: v2 is a
/// separate contract, so "it worked in v1" proves nothing about it.
contract ACROracleV2Test is Test {
    ACROracleV2 oracle;
    bytes32 constant INF = bytes32("ACR-INF");
    bytes32 constant GPU = bytes32("ACR-GPU");
    bytes32 constant POLICY = keccak256("acr.cleaning.v1");

    uint256 signerPk = 0xA11CE;
    address signer;
    uint256 badPk = 0xBADBAD;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new ACROracleV2();
        signer = vm.addr(signerPk);
        oracle.setSigner(signer, true);
    }

    function _input(uint64 ts) internal pure returns (ACROracleV2.PrintInput memory p) {
        p = ACROracleV2.PrintInput({
            indexId: INF,
            value: 0.5e18,
            ciLo: 0.48e18,
            ciHi: 0.52e18,
            attackCostPerBp: 1000e6,
            timestamp: ts,
            humanAdjustedBound: 0,
            policyHash: POLICY,
            windowStart: ts - 3600,
            windowEnd: ts
        });
    }

    function _post(ACROracleV2.PrintInput memory p, uint256 pk) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, oracle.printDigest(p));
        oracle.postPrint(p, v, r, s);
    }

    function _post(ACROracleV2.PrintInput memory p) internal {
        _post(p, signerPk);
    }

    // --- the four new fields ------------------------------------------------

    function test_the_new_fields_survive_the_round_trip() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.humanAdjustedBound = 4000e6;
        _post(p);

        ACROracleV2.Print memory got = oracle.latestPrint(INF);
        assertEq(got.policyHash, POLICY);
        assertEq(got.humanAdjustedBound, 4000e6);
        assertEq(got.windowStart, 500_000 - 3600);
        assertEq(got.windowEnd, 500_000);
        assertEq(got.value, 0.5e18, "v1's fields still work");
    }

    /// So a consumer wanting only the policy and window does not decode an
    /// eleven-field tuple to get them.
    function test_printMeta_reads_the_v2_fields_narrowly() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.humanAdjustedBound = 4000e6;
        _post(p);

        (bytes32 policy, uint64 ws, uint64 we, uint256 human) = oracle.printMeta(INF);
        assertEq(policy, POLICY);
        assertEq(ws, 500_000 - 3600);
        assertEq(we, 500_000);
        assertEq(human, 4000e6);
    }

    // --- policyHash ---------------------------------------------------------

    /// A print that does not say which policy cleaned it cannot be re-derived,
    /// which is the entire reason the field exists.
    function test_RevertWhen_NoPolicyHash() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.policyHash = bytes32(0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("no policy");
        oracle.postPrint(p, v, r, s);
    }

    // --- the window ---------------------------------------------------------

    function test_RevertWhen_EmptyWindow() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.windowStart = p.windowEnd;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("empty window");
        oracle.postPrint(p, v, r, s);
    }

    /// A print may not claim to summarize the future.
    function test_RevertWhen_WindowEndsAfterThePrint() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.windowEnd = p.timestamp + 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("window ends after print");
        oracle.postPrint(p, v, r, s);
    }

    function test_RevertWhen_WindowWiderThanTheMaximum() public {
        // Real epoch time, not setUp's small clock: a window wider than a month
        // cannot even be expressed below a timestamp of 1_000_000 without
        // underflowing, so testing the guard there would test uint64 instead.
        vm.warp(1_785_000_000);
        ACROracleV2.PrintInput memory p = _input(1_784_999_000);
        p.windowStart = p.windowEnd - (oracle.MAX_WINDOW_SPAN() + 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("window too wide");
        oracle.postPrint(p, v, r, s);
    }

    /// A window that closed a day before the print was stamped describes
    /// something else entirely.
    function test_RevertWhen_WindowIsStale() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.windowEnd = p.timestamp - (oracle.MAX_WINDOW_LAG() + 1);
        p.windowStart = p.windowEnd - 3600;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("window too old");
        oracle.postPrint(p, v, r, s);
    }

    // --- the human bound ----------------------------------------------------

    /// Zero is the sentinel for "not computed" — the World module has not
    /// shipped, and a slot with no data must read as absent rather than free.
    function test_zero_human_bound_is_accepted_as_not_computed() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.humanAdjustedBound = 0;
        _post(p);
        (,,, uint256 human) = oracle.printMeta(INF);
        assertEq(human, 0);
    }

    /// Attacking through verified humans is by construction at least as
    /// expensive as attacking through wallets — identities are the scarce
    /// input. A positive value below the wallet bound is a keeper bug, and
    /// publishing it would understate the cost of moving the index.
    function test_RevertWhen_HumanBoundBelowWalletBound() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.humanAdjustedBound = p.attackCostPerBp - 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("human bound below wallet bound");
        oracle.postPrint(p, v, r, s);
    }

    function test_a_human_bound_equal_to_the_wallet_bound_is_allowed() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.humanAdjustedBound = p.attackCostPerBp;
        _post(p);
        (,,, uint256 human) = oracle.printMeta(INF);
        assertEq(human, p.attackCostPerBp);
    }

    // --- v1's guarantees, re-asserted on a separate contract ----------------

    function test_AnyRelayerCanPostSignedPrint() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.prank(address(0xBEEF)); // authenticity is in the signature, not the sender
        oracle.postPrint(p, v, r, s);
        assertEq(oracle.latestValue(INF), 0.5e18);
    }

    function test_RevertWhen_UnauthorizedSigner() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(badPk, oracle.printDigest(p));
        vm.expectRevert("bad signer");
        oracle.postPrint(p, v, r, s);
    }

    /// The signature covers every one of the ten fields, including the new
    /// ones — tampering with the policy after signing must not be honoured.
    function test_RevertWhen_PolicyTamperedAfterSigning() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        p.policyHash = keccak256("a different policy");
        vm.expectRevert("bad signer");
        oracle.postPrint(p, v, r, s);
    }

    function test_RevertWhen_WindowTamperedAfterSigning() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        p.windowStart = p.windowStart - 60;
        vm.expectRevert("bad signer");
        oracle.postPrint(p, v, r, s);
    }

    function test_RevertWhen_ValueOutsideCI() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.value = 0.6e18;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("value outside CI");
        oracle.postPrint(p, v, r, s);
    }

    function test_RevertWhen_NonMonotoneTimestamp() public {
        _post(_input(500_000));
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("non-monotone ts");
        oracle.postPrint(p, v, r, s);
    }

    function test_BrickResistance_FarFutureTimestampRejected() public {
        ACROracleV2.PrintInput memory p = _input(uint64(block.timestamp + 10 days));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("ts in future");
        oracle.postPrint(p, v, r, s);
    }

    function test_MultiIndexIndependentMonotonicity() public {
        _post(_input(500_000));
        ACROracleV2.PrintInput memory g = _input(400_000);
        g.indexId = GPU; // an earlier ts on a DIFFERENT index must still post
        _post(g);
        assertEq(oracle.latestPrint(GPU).timestamp, 400_000);
        assertEq(oracle.latestPrint(INF).timestamp, 500_000);
    }

    function test_Pause() public {
        oracle.setPaused(true);
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        vm.expectRevert("paused");
        oracle.postPrint(p, v, r, s);
    }

    function test_TwoStepOwnership() public {
        address next = address(0xC0FFEE);
        oracle.transferOwnership(next);
        assertEq(oracle.owner(), address(this), "not transferred until accepted");
        vm.prank(next);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), next);
    }

    function test_StalenessViews() public {
        _post(_input(500_000));
        assertFalse(oracle.isStale(INF, 3600));
        vm.warp(block.timestamp + 7200);
        assertTrue(oracle.isStale(INF, 3600));
        (, uint256 age) = oracle.latestPrintWithAge(INF);
        assertEq(age, 7200);
    }

    function test_EmitsPricePosted() public {
        ACROracleV2.PrintInput memory p = _input(500_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.printDigest(p));
        // policyHash is indexed so `--rederive-cleaning` can filter by topic.
        vm.expectEmit(true, true, true, true);
        emit ACROracleV2.PricePosted(
            INF, POLICY, signer, p.value, p.ciLo, p.ciHi, p.attackCostPerBp, 0,
            p.windowStart, p.windowEnd, p.timestamp
        );
        oracle.postPrint(p, v, r, s);
    }

    function test_RevertWhen_NoPrint() public {
        vm.expectRevert("no print");
        oracle.latestValue(GPU);
    }

    function test_history_accumulates() public {
        _post(_input(500_000));
        _post(_input(503_600));
        assertEq(oracle.historyLength(INF), 2);
        assertEq(oracle.historyAt(INF, 0).timestamp, 500_000);
        assertEq(oracle.historyAt(INF, 1).timestamp, 503_600);
        assertEq(oracle.indexCount(), 1);
        assertEq(oracle.indexAt(0), INF);
    }

    /// The domain separator differs from v1's ("2" vs "1") AND binds this
    /// address, so a v1 signature can never be replayed here.
    function test_the_domain_is_distinct_from_v1() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Oracle")),
                keccak256(bytes("2")),
                block.chainid,
                address(oracle)
            )
        );
        assertEq(oracle.DOMAIN_SEPARATOR(), expected);
    }

    function testFuzz_ValidPrintsAlwaysWithinCI(uint256 v_, uint256 spread) public {
        v_ = bound(v_, 1e15, 1e21);
        spread = bound(spread, 1, v_ / 2);
        ACROracleV2.PrintInput memory p = _input(500_000);
        p.value = v_;
        p.ciLo = v_ - spread;
        p.ciHi = v_ + spread;
        _post(p);
        ACROracleV2.Print memory got = oracle.latestPrint(INF);
        assertTrue(got.ciLo <= got.value && got.value <= got.ciHi);
        assertTrue(got.policyHash != bytes32(0), "every stored print names a policy");
    }
}
