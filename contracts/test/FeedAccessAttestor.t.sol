// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeedAccessAttestor} from "../src/FeedAccessAttestor.sol";

/// Tests for the x402→on-chain bridge. The interesting cases are all the ones
/// where a receipt must NOT be honoured: a forged signer, a replayed nonce, an
/// attestation that grants a century of access, one that has already expired.
contract FeedAccessAttestorTest is Test {
    FeedAccessAttestor internal att;

    uint256 internal signerKey = 0xA11CE;
    address internal signerAddr;
    uint256 internal impostorKey = 0xBAD;

    address internal payer = address(0xE0A);
    address internal beneficiary = address(0x5CA9);

    function setUp() public {
        signerAddr = vm.addr(signerKey);
        att = new FeedAccessAttestor();
        att.setSigner(signerAddr, true);
        vm.warp(1_785_000_000);
    }

    function _sign(uint256 key, uint64 until_, uint256 amount, uint256 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = att.accessDigest(payer, beneficiary, until_, amount, nonce);
        (v, r, s) = vm.sign(key, digest);
    }

    function test_redeem_grants_access() public {
        uint64 until_ = uint64(block.timestamp + 7 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 1);

        assertFalse(att.hasFeedAccess(beneficiary));
        att.redeem(payer, beneficiary, until_, 300, 1, v, r, s);

        assertTrue(att.hasFeedAccess(beneficiary));
        assertEq(att.paidUntil(beneficiary), until_);
        assertEq(att.totalPaidUsdc(beneficiary), 300);
    }

    /// The whole security model. Without this the "receipt" is a wish.
    function test_forged_signature_is_refused() public {
        uint64 until_ = uint64(block.timestamp + 7 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(impostorKey, until_, 300, 1);
        vm.expectRevert("bad signer");
        att.redeem(payer, beneficiary, until_, 300, 1, v, r, s);
    }

    /// A de-authorized signer's old receipts must stop working immediately —
    /// otherwise revoking a compromised key does nothing.
    function test_revoked_signer_is_refused() public {
        uint64 until_ = uint64(block.timestamp + 7 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 1);
        att.setSigner(signerAddr, false);
        vm.expectRevert("bad signer");
        att.redeem(payer, beneficiary, until_, 300, 1, v, r, s);
    }

    function test_nonce_cannot_be_replayed() public {
        uint64 until_ = uint64(block.timestamp + 7 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 7);
        att.redeem(payer, beneficiary, until_, 300, 7, v, r, s);
        vm.expectRevert("nonce used");
        att.redeem(payer, beneficiary, until_, 300, 7, v, r, s);
    }

    /// A signer compromise should cost weeks of free access, not a century.
    function test_absurd_window_is_refused() public {
        uint64 until_ = uint64(block.timestamp + 3650 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 2);
        vm.expectRevert("window too long");
        att.redeem(payer, beneficiary, until_, 300, 2, v, r, s);
    }

    function test_expired_attestation_is_refused() public {
        uint64 until_ = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 3);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert("already expired");
        att.redeem(payer, beneficiary, until_, 300, 3, v, r, s);
    }

    /// Redeeming an older receipt after a newer one must not REVOKE access the
    /// beneficiary already holds — the natural bug in "just assign paidUntil".
    function test_a_late_older_receipt_does_not_shorten_access() public {
        uint64 far = uint64(block.timestamp + 30 days);
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(signerKey, far, 100, 10);
        att.redeem(payer, beneficiary, far, 100, 10, v1, r1, s1);

        uint64 near = uint64(block.timestamp + 1 days);
        (uint8 v2, bytes32 r2, bytes32 s2) = _sign(signerKey, near, 100, 11);
        att.redeem(payer, beneficiary, near, 100, 11, v2, r2, s2);

        assertEq(att.paidUntil(beneficiary), far, "an older receipt shortened access");
        assertEq(att.totalPaidUsdc(beneficiary), 200, "spend must still accumulate");
    }

    /// Payer and beneficiary differ by design: an x402 `exact` settlement is
    /// signed by an EOA, so a Circle agent wallet pays from its BACKING EOA
    /// while its smart account is what trades.
    function test_payer_and_beneficiary_may_differ() public {
        uint64 until_ = uint64(block.timestamp + 7 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 4);
        att.redeem(payer, beneficiary, until_, 300, 4, v, r, s);
        assertTrue(att.hasFeedAccess(beneficiary));
        assertFalse(att.hasFeedAccess(payer), "access follows the beneficiary");
    }

    function test_access_lapses_when_the_window_passes() public {
        uint64 until_ = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = _sign(signerKey, until_, 300, 5);
        att.redeem(payer, beneficiary, until_, 300, 5, v, r, s);
        assertTrue(att.hasFeedAccess(beneficiary));
        vm.warp(block.timestamp + 2 days);
        assertFalse(att.hasFeedAccess(beneficiary), "access must expire on its own");
    }

    function test_only_owner_sets_signers() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not owner");
        att.setSigner(address(0xBEEF), true);
    }
}
