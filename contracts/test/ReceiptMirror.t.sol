// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReceiptMirror} from "../src/ReceiptMirror.sol";

/// Tests for the x402→subgraph bridge. As with `FeedAccessAttestor`, the
/// interesting cases are the ones a settlement must NOT be honoured in: a forged
/// signer, a replayed Gateway ref, a settlement dated into the future, one
/// backdated behind a payer's own history, a finalize lifted off another record.
contract ReceiptMirrorTest is Test {
    ReceiptMirror internal mirror;

    uint256 internal signerKey = 0xA11CE;
    address internal signerAddr;
    uint256 internal impostorKey = 0xBAD;

    address internal payer = address(0xE0A);
    address internal seller = address(0x5E11E2);
    bytes32 internal indexId = bytes32(bytes("ACR-INF"));
    bytes32 internal ref = keccak256("gateway-ref-1");
    bytes32 internal sid = keccak256("settlement-1");

    function setUp() public {
        signerAddr = vm.addr(signerKey);
        mirror = new ReceiptMirror();
        mirror.setSigner(signerAddr, true);
        vm.warp(1_785_000_000);
    }

    function _signOpen(uint256 key, bytes32 sid_, uint256 amount, uint64 settledAt, bytes32 ref_)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest =
            mirror.openDigest(sid_, payer, seller, indexId, amount, settledAt, ref_, true);
        (v, r, s) = vm.sign(key, digest);
    }

    function _open(bytes32 sid_, uint256 amount, uint64 settledAt, bytes32 ref_) internal {
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid_, amount, settledAt, ref_);
        mirror.openSettlement(sid_, payer, seller, indexId, amount, settledAt, ref_, true, v, r, s);
    }

    function _signFinalize(uint256 key, bytes32 sid_, uint8 unit, uint256 quantity)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        (v, r, s) = vm.sign(key, mirror.finalizeDigest(sid_, unit, quantity));
    }

    // --- the happy path ------------------------------------------------------

    function test_open_then_finalize_records_both_phases() public {
        uint64 settledAt = uint64(block.timestamp - 30);
        _open(sid, 100, settledAt, ref);

        (address p,,,, bool finalized,,,,,) = _unpack(sid);
        assertEq(p, payer);
        assertFalse(finalized, "not finalized until phase 2");

        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(signerKey, sid, 0, 1.5e18);
        mirror.finalizeSettlement(sid, 0, 1.5e18, v, r, s);
        assertTrue(mirror.isFinalized(sid));
    }

    /// The arrival anchor is committed in phase 1 and must be structurally out of
    /// reach in phase 2 — that is the entire reason the write is split.
    function test_finalize_cannot_move_the_arrival_anchor() public {
        uint64 settledAt = uint64(block.timestamp - 30);
        _open(sid, 100, settledAt, ref);

        vm.warp(block.timestamp + 3000); // a new print could have landed here
        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(signerKey, sid, 0, 1.5e18);
        mirror.finalizeSettlement(sid, 0, 1.5e18, v, r, s);

        (, uint64 storedSettledAt,,,,,,,,) = _unpack(sid);
        assertEq(storedSettledAt, settledAt, "phase 2 reached the arrival anchor");
    }

    // --- signatures ----------------------------------------------------------

    function test_forged_open_signature_is_refused() public {
        uint64 settledAt = uint64(block.timestamp - 30);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(impostorKey, sid, 100, settledAt, ref);
        vm.expectRevert("bad signer");
        mirror.openSettlement(sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s);
    }

    function test_forged_finalize_signature_is_refused() public {
        _open(sid, 100, uint64(block.timestamp - 30), ref);
        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(impostorKey, sid, 0, 1.5e18);
        vm.expectRevert("bad signer");
        mirror.finalizeSettlement(sid, 0, 1.5e18, v, r, s);
    }

    /// `quantity` is the denominator of every published slippage number, so a
    /// finalize signature must be provably about ONE record. Without
    /// `settlementId` in the typehash this lift succeeds.
    function test_a_finalize_signature_cannot_be_lifted_to_another_record() public {
        bytes32 other = keccak256("settlement-2");
        _open(sid, 100, uint64(block.timestamp - 30), ref);
        _open(other, 100, uint64(block.timestamp - 20), keccak256("gateway-ref-2"));

        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(signerKey, sid, 0, 1.5e18);
        vm.expectRevert("bad signer");
        mirror.finalizeSettlement(other, 0, 1.5e18, v, r, s);
    }

    function test_revoked_signer_is_refused() public {
        uint64 settledAt = uint64(block.timestamp - 30);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, 100, settledAt, ref);
        mirror.setSigner(signerAddr, false);
        vm.expectRevert("bad signer");
        mirror.openSettlement(sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s);
    }

    // --- G1..G4 --------------------------------------------------------------

    /// G1. Also proves the check runs BEFORE the lag arithmetic: without the
    /// ordering this reverts with a bare arithmetic panic instead of saying why.
    function test_g1_a_settlement_dated_into_the_future_is_refused() public {
        uint64 settledAt = uint64(block.timestamp + 60);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, 100, settledAt, ref);
        vm.expectRevert("settled in the future");
        mirror.openSettlement(sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s);
    }

    /// G2. Prints are hourly, so an hour leaves at most one print boundary
    /// reachable on the ordinary path.
    function test_g2_a_stale_mirror_is_refused() public {
        uint64 settledAt = uint64(block.timestamp - 2 hours);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, 100, settledAt, ref);
        vm.expectRevert("mirror too late");
        mirror.openSettlement(sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s);
    }

    /// G3. The guard that actually kills backdating: withholding a receipt to
    /// see whether the next print moves favourably freezes that payer's stream.
    function test_g3_backdating_behind_a_payers_own_history_is_refused() public {
        _open(sid, 100, uint64(block.timestamp - 60), ref);

        bytes32 older = keccak256("settlement-older");
        uint64 earlier = uint64(block.timestamp - 300);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, older, 100, earlier, keccak256("ref-older"));
        vm.expectRevert("backdated for payer");
        mirror.openSettlement(
            older, payer, seller, indexId, 100, earlier, keccak256("ref-older"), true, v, r, s
        );
    }

    /// The floor is per-payer, not global: one payer's history must not block a
    /// different payer's ordinary settlement.
    function test_g3_is_scoped_to_one_payer() public {
        _open(sid, 100, uint64(block.timestamp - 60), ref);

        address other = address(0xBEEF);
        bytes32 sid2 = keccak256("settlement-other-payer");
        bytes32 ref2 = keccak256("ref-other-payer");
        uint64 earlier = uint64(block.timestamp - 300);
        bytes32 digest = mirror.openDigest(sid2, other, seller, indexId, 100, earlier, ref2, true);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        mirror.openSettlement(sid2, other, seller, indexId, 100, earlier, ref2, true, v, r, s);

        (address p,,,,,,,,,) = _unpack(sid2);
        assertEq(p, other, "a second payer's earlier settlement must still mirror");
    }

    /// G4. An outage should cost a label, not a hole in the tape.
    function test_g4_the_late_path_mirrors_a_backlog_and_flags_it() public {
        uint64 settledAt = uint64(block.timestamp - 5 hours);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, 100, settledAt, ref);
        mirror.openSettlementLate(
            sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s
        );
        (,,,, , , , , , bool late) = _unpackLate(sid);
        assertTrue(late, "a backlogged mirror must be labelled");
    }

    /// The late path is an operator decision, not a keeper one.
    function test_g4_the_late_path_is_owner_only() public {
        uint64 settledAt = uint64(block.timestamp - 5 hours);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, 100, settledAt, ref);
        vm.prank(address(0xDEAD));
        vm.expectRevert("not owner");
        mirror.openSettlementLate(
            sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s
        );
    }

    /// Even the operator path cannot date a settlement into the future.
    function test_g4_the_late_path_still_obeys_g1() public {
        uint64 settledAt = uint64(block.timestamp + 60);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, 100, settledAt, ref);
        vm.expectRevert("settled in the future");
        mirror.openSettlementLate(
            sid, payer, seller, indexId, 100, settledAt, ref, true, v, r, s
        );
    }

    // --- replay --------------------------------------------------------------

    /// The Gateway ref IS the nonce: one mirror per off-chain settlement, with no
    /// synthetic nonce space to keep in sync.
    function test_a_gateway_ref_cannot_be_mirrored_twice() public {
        _open(sid, 100, uint64(block.timestamp - 60), ref);

        bytes32 sid2 = keccak256("settlement-dupe");
        uint64 settledAt = uint64(block.timestamp - 30);
        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid2, 100, settledAt, ref);
        vm.expectRevert("ref already mirrored");
        mirror.openSettlement(sid2, payer, seller, indexId, 100, settledAt, ref, true, v, r, s);
    }

    function test_a_settlement_cannot_be_opened_twice() public {
        _open(sid, 100, uint64(block.timestamp - 60), ref);
        (uint8 v, bytes32 r, bytes32 s) =
            _signOpen(signerKey, sid, 100, uint64(block.timestamp - 30), keccak256("ref-2"));
        vm.expectRevert("already opened");
        mirror.openSettlement(
            sid, payer, seller, indexId, 100, uint64(block.timestamp - 30),
            keccak256("ref-2"), true, v, r, s
        );
    }

    function test_finalize_without_open_is_refused() public {
        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(signerKey, sid, 0, 1.5e18);
        vm.expectRevert("not opened");
        mirror.finalizeSettlement(sid, 0, 1.5e18, v, r, s);
    }

    function test_double_finalize_is_refused() public {
        _open(sid, 100, uint64(block.timestamp - 30), ref);
        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(signerKey, sid, 0, 1.5e18);
        mirror.finalizeSettlement(sid, 0, 1.5e18, v, r, s);
        vm.expectRevert("already finalized");
        mirror.finalizeSettlement(sid, 0, 1.5e18, v, r, s);
    }

    /// A zero quantity would make the subgraph's `amount * 1e30 / quantity`
    /// divide by zero — reject it here rather than in a mapping that cannot be
    /// re-run.
    function test_zero_quantity_is_refused() public {
        _open(sid, 100, uint64(block.timestamp - 30), ref);
        (uint8 v, bytes32 r, bytes32 s) = _signFinalize(signerKey, sid, 0, 0);
        vm.expectRevert("zero quantity");
        mirror.finalizeSettlement(sid, 0, 0, v, r, s);
    }

    function test_only_owner_sets_signers() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not owner");
        mirror.setSigner(address(0xBEEF), true);
    }

    // --- fuzz ----------------------------------------------------------------

    /// Whatever the amounts, the arrival anchor survives finalize untouched and
    /// the record ends up finalized exactly once.
    function testFuzz_finalizeNeverDisturbsPhaseOne(uint128 amount, uint128 quantity, uint32 age)
        public
    {
        vm.assume(amount > 0 && quantity > 0);
        age = uint32(bound(age, 0, uint32(mirror.MAX_MIRROR_LAG())));
        uint64 settledAt = uint64(block.timestamp - age);

        (uint8 v, bytes32 r, bytes32 s) = _signOpen(signerKey, sid, amount, settledAt, ref);
        mirror.openSettlement(sid, payer, seller, indexId, amount, settledAt, ref, true, v, r, s);

        (uint8 fv, bytes32 fr, bytes32 fs) = _signFinalize(signerKey, sid, 0, quantity);
        mirror.finalizeSettlement(sid, 0, quantity, fv, fr, fs);

        (, uint64 storedSettledAt,,,,,, , uint256 storedAmount,) = _unpack(sid);
        assertEq(storedSettledAt, settledAt);
        assertEq(storedAmount, amount);
        assertTrue(mirror.isFinalized(sid));
    }

    // --- helpers -------------------------------------------------------------
    // The public mapping getter returns the struct flattened; naming the pieces
    // here keeps every assertion above readable.

    function _unpack(bytes32 id)
        internal
        view
        returns (
            address p, uint64 settledAt, uint8 unit, bool synthetic, bool finalized,
            bool late, address seller_, uint64 openedAt, uint256 amount, uint256 quantity
        )
    {
        bytes32 idx;
        (p, settledAt, unit, synthetic, late, finalized, seller_, openedAt, idx, amount, quantity)
        = mirror.settlements(id);
    }

    function _unpackLate(bytes32 id)
        internal
        view
        returns (
            address p, uint64 settledAt, uint8 unit, bool synthetic, bool finalized,
            address seller_, uint64 openedAt, uint256 amount, uint256 quantity, bool late
        )
    {
        bytes32 idx;
        (p, settledAt, unit, synthetic, late, finalized, seller_, openedAt, idx, amount, quantity)
        = mirror.settlements(id);
    }
}
