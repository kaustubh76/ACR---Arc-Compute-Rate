// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {HumanIdMirror} from "../src/HumanIdMirror.sol";

/// Tests for the human-grouping mirror. The interesting cases are the ones a
/// resolution must NOT be honoured in: a forged resolver, a second cluster for a
/// wallet inside one window (the farm-churn attack the contract exists to stop),
/// a window that is not the one in progress, and a rebind attempted by anyone
/// but the owner.
contract HumanIdMirrorTest is Test {
    HumanIdMirror internal mirror;

    uint256 internal signerKey = 0xA11CE;
    address internal signerAddr;
    uint256 internal impostorKey = 0xBAD;

    address internal walletA = address(0xA1);
    address internal walletB = address(0xB2);
    bytes32 internal clusterX = keccak256("cluster-x");
    bytes32 internal clusterY = keccak256("cluster-y");
    bytes32 internal saltCommitment = keccak256("acr.humanid.salt.test");
    bool internal constant SANDBOX = true;
    bool internal constant ORB = false;

    function setUp() public {
        signerAddr = vm.addr(signerKey);
        mirror = new HumanIdMirror(saltCommitment);
        mirror.setSigner(signerAddr, true);
        vm.warp(1_785_000_000);
    }

    // --- the happy path ------------------------------------------------------

    function test_a_resolution_records_the_cluster_for_the_current_window() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        assertEq(mirror.clusterOf(walletA, w), clusterX);
        assertEq(mirror.currentCluster(walletA), clusterX);
        assertTrue(mirror.isHumanBacked(walletA));
    }

    /// The fleet case, and the whole reason the contract exists: two wallets
    /// carrying one cluster is how the cap learns they are one person.
    function test_two_wallets_may_share_one_cluster() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);
        _record(walletB, clusterX, w);

        assertEq(mirror.clusterOf(walletA, w), clusterX);
        assertEq(mirror.clusterOf(walletB, w), clusterX);
    }

    /// The resolver is a loop that reruns. "Already correct" must not be
    /// indistinguishable from "failed", so a repeat is a no-op and not a revert.
    function test_re_recording_the_same_resolution_is_a_no_op() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);
        _record(walletA, clusterX, w);

        assertEq(mirror.clusterOf(walletA, w), clusterX);
    }

    function test_an_unresolved_wallet_is_not_human_backed() public view {
        assertTrue(!mirror.isHumanBacked(walletA));
        assertEq(mirror.currentCluster(walletA), bytes32(0));
    }

    // --- the churn defence ---------------------------------------------------

    /// Without this a farm churns one wallet through many clusters inside a
    /// window and buys back exactly the sybil headroom the human cap removes.
    function test_a_second_cluster_inside_one_window_is_refused() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterY, w, SANDBOX);
        vm.expectRevert("already clustered");
        mirror.record(walletA, clusterY, w, SANDBOX, v, r, s);
    }

    // --- signatures ----------------------------------------------------------

    function test_forged_resolution_signature_is_refused() public {
        uint64 w = mirror.currentWindow();
        (uint8 v, bytes32 r, bytes32 s) = _sign(impostorKey, walletA, clusterX, w, SANDBOX);
        vm.expectRevert("bad signer");
        mirror.record(walletA, clusterX, w, SANDBOX, v, r, s);
    }

    function test_revoked_signer_is_refused() public {
        uint64 w = mirror.currentWindow();
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterX, w, SANDBOX);
        mirror.setSigner(signerAddr, false);

        vm.expectRevert("bad signer");
        mirror.record(walletA, clusterX, w, SANDBOX, v, r, s);
    }

    /// A resolution signature names its wallet, so it cannot be lifted onto a
    /// different one — the same property `FINALIZE_TYPEHASH` gives ReceiptMirror.
    function test_a_resolution_cannot_be_lifted_to_another_wallet() public {
        uint64 w = mirror.currentWindow();
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterX, w, SANDBOX);

        vm.expectRevert("bad signer");
        mirror.record(walletB, clusterX, w, SANDBOX, v, r, s);
    }

    // --- the window rules ----------------------------------------------------

    /// A future window would let a resolver pre-commit groupings before the flow
    /// they describe exists.
    function test_a_future_window_is_refused() public {
        uint64 w = mirror.currentWindow() + 1;
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterX, w, SANDBOX);
        vm.expectRevert("not the current window");
        mirror.record(walletA, clusterX, w, SANDBOX, v, r, s);
    }

    /// A past window would let it rewrite a window the tape has already counted.
    function test_a_past_window_is_refused() public {
        uint64 w = mirror.currentWindow() - 1;
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterX, w, SANDBOX);
        vm.expectRevert("not the current window");
        mirror.record(walletA, clusterX, w, SANDBOX, v, r, s);
    }

    /// Rotation is the privacy property: last window's grouping does not follow
    /// the wallet into this one.
    function test_a_cluster_does_not_survive_into_the_next_window() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);
        assertTrue(mirror.isHumanBacked(walletA));

        vm.warp(block.timestamp + mirror.RATING_WINDOW());

        assertTrue(!mirror.isHumanBacked(walletA));
        assertEq(mirror.currentCluster(walletA), bytes32(0));
        // The old window keeps its answer — history is not rewritten by time.
        assertEq(mirror.clusterOf(walletA, w), clusterX);
    }

    function test_the_same_wallet_takes_a_new_cluster_in_the_next_window() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        vm.warp(block.timestamp + mirror.RATING_WINDOW());
        uint64 next = mirror.currentWindow();
        assertEq(next, w + 1);
        _record(walletA, clusterY, next);

        assertEq(mirror.clusterOf(walletA, next), clusterY);
        assertEq(mirror.clusterOf(walletA, w), clusterX);
    }

    /// The window is the chain's arithmetic, not a reimplementation of it — the
    /// resolver reads it from here.
    function test_the_window_is_derived_from_the_rating_window() public view {
        uint64 span = mirror.RATING_WINDOW();
        assertEq(span, 7 days);
        assertEq(mirror.windowOf(uint64(block.timestamp)), mirror.currentWindow());
        assertEq(mirror.windowOf(span * 3), 3);
        assertEq(mirror.windowOf(span * 3 - 1), 2);
    }

    // --- rebind --------------------------------------------------------------

    function test_owner_can_rebind_a_wrong_grouping() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);
        _record(walletB, clusterY, w); // clusterY must be a cluster that exists

        mirror.ownerRebind(walletA, w, clusterY);
        assertEq(mirror.clusterOf(walletA, w), clusterY);
    }

    /// A resolver key that could rebind at will would defeat the cap it exists
    /// to enforce.
    function test_rebind_is_owner_only() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        vm.prank(address(0xDEAD));
        vm.expectRevert("not owner");
        mirror.ownerRebind(walletA, w, clusterY);
    }

    function test_owner_can_clear_a_resolution_by_rebinding_to_zero() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        mirror.ownerRebind(walletA, w, bytes32(0));
        assertTrue(!mirror.isHumanBacked(walletA));
    }

    function test_a_rebind_that_changes_nothing_is_refused() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        vm.expectRevert("no change");
        mirror.ownerRebind(walletA, w, clusterX);
    }

    /// The owner may correct a past window; only `record` is pinned to the
    /// current one. A correction that could not reach the window it was wrong in
    /// would not be a correction.
    function test_owner_may_rebind_a_past_window() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);
        _record(walletB, clusterY, w); // the correction's target must exist
        vm.warp(block.timestamp + mirror.RATING_WINDOW());

        mirror.ownerRebind(walletA, w, clusterY);
        assertEq(mirror.clusterOf(walletA, w), clusterY);
    }

    // --- zero guards ---------------------------------------------------------

    function test_a_zero_wallet_is_refused() public {
        uint64 w = mirror.currentWindow();
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, address(0), clusterX, w, SANDBOX);
        vm.expectRevert("zero wallet");
        mirror.record(address(0), clusterX, w, SANDBOX, v, r, s);
    }

    /// Zero is the "not resolved" sentinel, so it can never be a cluster: the
    /// tape has no way to say "resolved as not human" and must not pretend to.
    function test_a_zero_cluster_is_refused() public {
        uint64 w = mirror.currentWindow();
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, bytes32(0), w, SANDBOX);
        vm.expectRevert("zero cluster");
        mirror.record(walletA, bytes32(0), w, SANDBOX, v, r, s);
    }

    function test_a_zero_salt_commitment_is_refused() public {
        vm.expectRevert("zero salt commitment");
        new HumanIdMirror(bytes32(0));
    }

    // --- the trust anchors ---------------------------------------------------

    function test_the_domain_binds_this_contract_and_chain() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Human Id Mirror")),
                keccak256(bytes("1")),
                block.chainid,
                address(mirror)
            )
        );
        assertEq(mirror.DOMAIN_SEPARATOR(), expected);
    }

    /// The salt is never published; the commitment to it is. Without this the
    /// resolver could retroactively pick salts to manufacture a grouping.
    function test_the_salt_commitment_is_recorded_and_immutable() public view {
        assertEq(mirror.SALT_COMMITMENT(), saltCommitment);
    }

    function test_the_deployer_is_authorized_and_others_are_not() public view {
        assertTrue(mirror.isSigner(address(this)));
        assertTrue(mirror.isSigner(signerAddr));
        assertTrue(!mirror.isSigner(vm.addr(impostorKey)));
    }

    function test_only_owner_sets_signers() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not owner");
        mirror.setSigner(address(0xBEEF), true);
    }

    function test_two_step_ownership() public {
        mirror.transferOwnership(address(0xBEEF));
        assertEq(mirror.owner(), address(this));

        vm.prank(address(0xBEEF));
        mirror.acceptOwnership();
        assertEq(mirror.owner(), address(0xBEEF));
    }

    function test_an_unaccepted_transfer_leaves_the_owner_in_place() public {
        mirror.transferOwnership(address(0xBEEF));

        vm.prank(address(0xDEAD));
        vm.expectRevert("not pending owner");
        mirror.acceptOwnership();
        assertEq(mirror.owner(), address(this));
    }

    // --- fuzz ----------------------------------------------------------------

    /// However many times the resolver reruns, a wallet holds exactly one
    /// cluster per window and repeats never disturb it.
    function testFuzz_repeatsNeverDisturbTheCluster(bytes32 clusterId, uint8 repeats) public {
        vm.assume(clusterId != bytes32(0));
        uint256 n = bound(uint256(repeats), 1, 8);
        uint64 w = mirror.currentWindow();

        for (uint256 i = 0; i < n; i++) {
            _record(walletA, clusterId, w);
        }
        assertEq(mirror.clusterOf(walletA, w), clusterId);
    }

    // --- provenance ----------------------------------------------------------

    function test_a_resolution_records_whether_the_human_is_sandbox() public {
        uint64 w = mirror.currentWindow();
        _recordAs(walletA, clusterX, w, SANDBOX);
        assertTrue(mirror.isSandboxCluster(clusterX));
        assertEq(mirror.clusterProvenance(clusterX), 2);
    }

    function test_an_orb_verified_human_is_not_marked_sandbox() public {
        uint64 w = mirror.currentWindow();
        _recordAs(walletA, clusterX, w, ORB);
        assertTrue(!mirror.isSandboxCluster(clusterX));
        assertEq(mirror.clusterProvenance(clusterX), 1);
    }

    /// Laundering a demo identity into a verified one would move a published
    /// number without moving anything real, so provenance may never flip.
    function test_provenance_cannot_be_flipped_by_a_later_record() public {
        uint64 w = mirror.currentWindow();
        _recordAs(walletA, clusterX, w, SANDBOX);

        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletB, clusterX, w, ORB);
        vm.expectRevert("provenance mismatch");
        mirror.record(walletB, clusterX, w, ORB, v, r, s);
    }

    /// …including on what would otherwise be an idempotent repeat. A repeat that
    /// claims the opposite provenance is not a repeat.
    function test_a_repeat_claiming_the_other_provenance_is_refused() public {
        uint64 w = mirror.currentWindow();
        _recordAs(walletA, clusterX, w, SANDBOX);

        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterX, w, ORB);
        vm.expectRevert("provenance mismatch");
        mirror.record(walletA, clusterX, w, ORB, v, r, s);
    }

    /// The flag is part of the signed message, so a relayer cannot flip it in
    /// transit — the signature simply stops recovering to an authorized signer.
    function test_the_sandbox_flag_is_covered_by_the_signature() public {
        uint64 w = mirror.currentWindow();
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, walletA, clusterX, w, SANDBOX);
        vm.expectRevert("bad signer");
        mirror.record(walletA, clusterX, w, ORB, v, r, s);
    }

    function test_an_unresolved_cluster_is_not_reported_as_sandbox() public view {
        assertTrue(!mirror.isSandboxCluster(clusterY));
        assertEq(mirror.clusterProvenance(clusterY), 0);
    }

    /// A rebind carries no provenance of its own, so it may only point at a
    /// cluster some resolution already established.
    function test_rebinding_into_an_unrecorded_cluster_is_refused() public {
        uint64 w = mirror.currentWindow();
        _record(walletA, clusterX, w);

        vm.expectRevert("unknown target cluster");
        mirror.ownerRebind(walletA, w, keccak256("never-recorded"));
    }

    // --- cross-implementation parity -----------------------------------------
    // The cluster id is computed OFF chain, because the contract must never see
    // a nullifier — so nothing on chain can check the resolver's arithmetic and
    // a drift between the two would be silent: the API would look up a cluster
    // the resolver never wrote, and every human would read as unresolved rather
    // than as an error.
    //
    // This vector is the anchor instead. Solidity computes it here; Python
    // computes it in acr_oracle_client.humanid; tests/test_human_window_parity.py
    // reads the expected value out of THIS FILE and asserts the two agree. If
    // either implementation moves, one of the two tests goes red — the same idiom
    // as ACRFutures.t.sol vs test_parity_onchain.py.

    bytes32 internal constant PARITY_NULLIFIER =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 internal constant PARITY_SALT =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    uint64 internal constant PARITY_WINDOW = 2951;
    bytes32 internal constant PARITY_CLUSTER_ID =
        0x090999f7f364e337a057904441dcd4322fe00bdbfac00e2e14a70ad0b8aa378c;

    /// abi.encode, NOT abi.encodePacked: the uint64 occupies a full 32-byte word.
    /// Packing it into 8 bytes would hash to something else entirely, and would
    /// do it consistently — failing only against the chain, which is the hardest
    /// kind of wrong to notice.
    function test_the_cluster_id_vector_matches_the_off_chain_derivation() public pure {
        assertEq(
            keccak256(abi.encode(PARITY_NULLIFIER, PARITY_SALT, PARITY_WINDOW)),
            PARITY_CLUSTER_ID
        );
    }

    /// The salt is never published; its keccak is, as SALT_COMMITMENT.
    function test_the_salt_commitment_vector_matches_the_off_chain_derivation() public pure {
        assertEq(
            keccak256(abi.encode(PARITY_SALT)),
            0xc4bd59e1394781d1c7bf20a2c0b30c2acc9fbdd52dc5e0d76917de4034ebdf59
        );
    }

    // --- helpers -------------------------------------------------------------
    // The digest is never rebuilt by hand here: it comes from the contract's own
    // public view, so a drift between the two shows up as a bad signature rather
    // than as two implementations agreeing with each other and nothing else.

    function _sign(
        uint256 key,
        address wallet_,
        bytes32 cluster_,
        uint64 window_,
        bool sandbox_
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(key, mirror.resolutionDigest(wallet_, cluster_, window_, sandbox_));
    }

    /// Demo identities are Sandbox ones, so that is the default these tests use;
    /// `_recordAs` is for the cases where the provenance IS what is under test.
    function _record(address wallet_, bytes32 cluster_, uint64 window_) internal {
        _recordAs(wallet_, cluster_, window_, SANDBOX);
    }

    function _recordAs(address wallet_, bytes32 cluster_, uint64 window_, bool sandbox_) internal {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, wallet_, cluster_, window_, sandbox_);
        mirror.record(wallet_, cluster_, window_, sandbox_, v, r, s);
    }
}
