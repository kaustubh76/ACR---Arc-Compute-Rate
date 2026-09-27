// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracle} from "../src/ACROracle.sol";

contract ACROracleTest is Test {
    ACROracle oracle;
    bytes32 constant INF = bytes32("ACR-INF");
    bytes32 constant GPU = bytes32("ACR-GPU");

    uint256 signerPk = 0xA11CE;
    address signer;
    uint256 badPk = 0xBADBAD;

    function setUp() public {
        // Post-genesis wall clock so small epoch-relative economic timestamps
        // (100, 200, …) sit comfortably below block.timestamp + MAX_TS_SKEW.
        vm.warp(1_000_000);
        oracle = new ACROracle();
        signer = vm.addr(signerPk);
        oracle.setSigner(signer, true);
    }

    function _sign(uint256 pk, bytes32 id, uint256 v_, uint256 lo, uint256 hi, uint256 bnd, uint64 ts)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        (v, r, s) = vm.sign(pk, oracle.printDigest(id, v_, lo, hi, bnd, ts));
    }

    function _post(uint256 v_, uint256 lo, uint256 hi, uint256 bnd, uint64 ts) internal {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, v_, lo, hi, bnd, ts);
        oracle.postPrint(INF, v_, lo, hi, bnd, ts, v, r, s);
    }

    function test_PostAndReadLatest() public {
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        ACROracle.Print memory p = oracle.latestPrint(INF);
        assertEq(p.value, 0.5e18);
        assertEq(p.postedAt, uint64(block.timestamp));
        assertEq(oracle.latestValue(INF), 0.5e18);
        assertEq(oracle.historyLength(INF), 1);
    }

    function test_AnyRelayerCanPostSignedPrint() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        // A relayer that is NOT a signer submits the signer's print — allowed.
        vm.prank(address(0xBEEF));
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
        assertEq(oracle.latestValue(INF), 0.5e18);
    }

    function test_RevertWhen_UnauthorizedSigner() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(badPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        vm.expectRevert("bad signer");
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
    }

    function test_RevertWhen_TamperedAfterSigning() public {
        // Sign for value 0.5, then submit 0.51 — the recovered signer no longer
        // matches, so verification fails.
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        vm.expectRevert("bad signer");
        oracle.postPrint(INF, 0.51e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
    }

    // NOTE: these sign first (a view call) and assert the revert directly on
    // postPrint, so vm.expectRevert targets the write, not the intermediate
    // printDigest view.
    function test_RevertWhen_ValueOutsideCI() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.6e18, 0.48e18, 0.52e18, 1000e6, 100);
        vm.expectRevert("value outside CI");
        oracle.postPrint(INF, 0.6e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
    }

    function test_RevertWhen_ZeroValue() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0, 0, 0.52e18, 1000e6, 100);
        vm.expectRevert("value=0");
        oracle.postPrint(INF, 0, 0, 0.52e18, 1000e6, 100, v, r, s);
    }

    function test_RevertWhen_ZeroBound() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 0, 100);
        vm.expectRevert("bound=0");
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 0, 100, v, r, s);
    }

    function test_RevertWhen_NonMonotoneTimestamp() public {
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        vm.expectRevert("non-monotone ts");
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
    }

    /// A far-future timestamp must revert on the skew check — NOT be accepted
    /// and permanently brick the feed via strict monotonicity.
    function test_BrickResistance_FarFutureTimestampRejected() public {
        (uint8 v, bytes32 r, bytes32 s) =
            _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, type(uint64).max);
        vm.expectRevert("ts in future");
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, type(uint64).max, v, r, s);
        // The feed is still alive: a normal post succeeds.
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        assertEq(oracle.historyLength(INF), 1);
    }

    function test_Pause() public {
        oracle.setPaused(true);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        vm.expectRevert("paused");
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
        oracle.setPaused(false);
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        assertEq(oracle.historyLength(INF), 1);
    }

    function test_RevertWhen_NonOwnerSetSigner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("not owner");
        oracle.setSigner(address(0xBEEF), true);
    }

    function test_TwoStepOwnership() public {
        address newOwner = address(0xB0B);
        oracle.transferOwnership(newOwner);
        assertEq(oracle.owner(), address(this)); // not transferred yet
        assertEq(oracle.pendingOwner(), newOwner);

        // A non-pending address cannot accept.
        vm.prank(address(0xBEEF));
        vm.expectRevert("not pending owner");
        oracle.acceptOwnership();

        vm.prank(newOwner);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), newOwner);

        // Old owner has lost admin rights.
        vm.expectRevert("not owner");
        oracle.setSigner(address(0xCAFE), true);
    }

    function test_MultiIndexIndependentMonotonicity() public {
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 500);
        // GPU at an *earlier* economic ts than INF's — allowed, feeds are independent.
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, GPU, 0.01e18, 0.009e18, 0.011e18, 1000e6, 100);
        oracle.postPrint(GPU, 0.01e18, 0.009e18, 0.011e18, 1000e6, 100, v, r, s);
        assertEq(oracle.indexCount(), 2);
        assertEq(oracle.latestValue(GPU), 0.01e18);
        assertEq(oracle.latestPrint(INF).timestamp, 500);
    }

    function test_StalenessViews() public {
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        assertFalse(oracle.isStale(INF, 3600));
        vm.warp(block.timestamp + 100);
        (, uint256 age) = oracle.latestPrintWithAge(INF);
        assertEq(age, 100);
        assertFalse(oracle.isStale(INF, 3600));
        assertTrue(oracle.isStale(INF, 50));
        assertTrue(oracle.isStale(GPU, 3600)); // no print at all -> stale
    }

    function test_EmitsPricePosted() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerPk, INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100);
        vm.expectEmit(true, true, false, true);
        emit ACROracle.PricePosted(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100, signer);
        oracle.postPrint(INF, 0.5e18, 0.48e18, 0.52e18, 1000e6, 100, v, r, s);
    }

    function test_RevertWhen_NoPrint() public {
        vm.expectRevert("no print");
        oracle.latestPrint(INF);
        vm.expectRevert("no print");
        oracle.latestValue(INF);
    }

    function testFuzz_ValidPrintsAlwaysWithinCI(uint256 v_, uint256 spread) public {
        v_ = bound(v_, 1, 1e24);
        spread = bound(spread, 0, 1e23);
        uint256 lo = v_ > spread ? v_ - spread : 0;
        uint256 hi = v_ + spread;
        (uint8 sv, bytes32 sr, bytes32 ss) = _sign(signerPk, INF, v_, lo, hi, 1, 1);
        oracle.postPrint(INF, v_, lo, hi, 1, 1, sv, sr, ss);
        ACROracle.Print memory p = oracle.latestPrint(INF);
        assertTrue(p.ciLo <= p.value && p.value <= p.ciHi);
    }

    // --- the settlement views the venue decodes (primitives, keyed on postedAt) ---

    function test_SettlementViews_EmptyHistory() public view {
        (bool found,,) = oracle.firstPrintPostedAtOrAfter(INF, 0);
        assertFalse(found, "nothing to find");
        (bool exists,,) = oracle.latestPrintPrimitive(INF);
        assertFalse(exists);
    }

    function test_FirstPrintPostedAtOrAfter_FindsByChainTime_NotSignerTime() public {
        // Three prints at block times 1_000_000 / +100 / +200, with signer
        // timestamps that are a different clock entirely (the Fixing clock).
        vm.warp(1_000_000);
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 7_000);
        vm.warp(1_000_100);
        _post(0.6e18, 0.58e18, 0.62e18, 1000e6, 7_001);
        vm.warp(1_000_200);
        _post(0.7e18, 0.68e18, 0.72e18, 1000e6, 7_002);

        (bool f, uint256 v, uint64 at) = oracle.firstPrintPostedAtOrAfter(INF, 1_000_000);
        assertTrue(f); assertEq(v, 0.5e18); assertEq(at, 1_000_000); // exact hit
        (f, v, at) = oracle.firstPrintPostedAtOrAfter(INF, 1_000_001);
        assertTrue(f); assertEq(v, 0.6e18); assertEq(at, 1_000_100); // strictly between → next
        (f, v, at) = oracle.firstPrintPostedAtOrAfter(INF, 1_000_200);
        assertTrue(f); assertEq(v, 0.7e18); // last, exact
        (f,,) = oracle.firstPrintPostedAtOrAfter(INF, 1_000_201);
        assertFalse(f, "nothing posted after the last print");
        (f, v,) = oracle.firstPrintPostedAtOrAfter(INF, 0);
        assertTrue(f); assertEq(v, 0.5e18, "from zero: the very first");

        (bool ex, uint256 lv, uint64 lat) = oracle.latestPrintPrimitive(INF);
        assertTrue(ex); assertEq(lv, 0.7e18); assertEq(lat, 1_000_200);
    }

    function test_FirstPrintPostedAtOrAfter_SameBlockPrintsResolveToTheEarliest() public {
        // Two prints in one block (postedAt equal): the search returns the first
        // stored, which is the first the chain saw.
        vm.warp(1_000_000);
        _post(0.5e18, 0.48e18, 0.52e18, 1000e6, 7_000);
        _post(0.9e18, 0.88e18, 0.92e18, 1000e6, 7_001);
        (bool f, uint256 v,) = oracle.firstPrintPostedAtOrAfter(INF, 1_000_000);
        assertTrue(f); assertEq(v, 0.5e18);
    }
}
