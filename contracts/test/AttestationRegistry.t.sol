// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";

contract AttestationRegistryTest is Test {
    AttestationRegistry reg;
    uint256 pk = 0xA11CE;
    address seller;

    function setUp() public {
        vm.warp(1_000_000);
        reg = new AttestationRegistry();
        seller = vm.addr(pk);
    }

    function _sign(
        uint8 service,
        uint8 modelClass,
        uint32 latencySloMs,
        bytes32 schemaId,
        uint256 nonce,
        uint64 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                reg.ATTESTATION_TYPEHASH(),
                seller,
                service,
                modelClass,
                latencySloMs,
                schemaId,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function test_AttestSelf() public {
        vm.prank(address(0xA11CE));
        reg.attest(0, 1, 250, bytes32("inf.v1"));
        assertTrue(reg.isAttested(address(0xA11CE)));
        AttestationRegistry.Attestation memory a = reg.getAttestation(address(0xA11CE));
        assertEq(a.modelClass, 1);
        assertEq(a.latencySloMs, 250);
        assertEq(reg.sellerCount(), 1);
    }

    function test_RevertWhen_BadService() public {
        vm.expectRevert("bad service");
        reg.attest(5, 1, 250, bytes32("x"));
    }

    function test_RevertWhen_BadClass() public {
        vm.expectRevert("bad class");
        reg.attest(0, 4, 250, bytes32("x"));
    }

    function test_RevertWhen_ZeroLatency() public {
        vm.expectRevert("bad latency");
        reg.attest(0, 1, 0, bytes32("x"));
    }

    function test_UpdateDoesNotDuplicateSeller() public {
        vm.startPrank(address(0xA11CE));
        reg.attest(0, 1, 250, bytes32("inf.v1"));
        reg.attest(0, 0, 100, bytes32("inf.v2"));
        vm.stopPrank();
        assertEq(reg.sellerCount(), 1);
        assertEq(reg.getAttestation(address(0xA11CE)).modelClass, 0);
    }

    function test_AttestWithSig() public {
        uint64 deadline = uint64(block.timestamp + 3600);
        (uint8 v, bytes32 r, bytes32 s) = _sign(0, 1, 250, bytes32("inf.v1"), 0, deadline);
        reg.attestWithSig(seller, 0, 1, 250, bytes32("inf.v1"), deadline, v, r, s);
        assertTrue(reg.isAttested(seller));
        assertEq(reg.nonces(seller), 1);
    }

    /// Replaying a captured signature must fail: the nonce has advanced, so the
    /// recomputed digest no longer recovers to the seller.
    function test_RevertWhen_ReplaySignature() public {
        uint64 deadline = uint64(block.timestamp + 3600);
        (uint8 v, bytes32 r, bytes32 s) = _sign(0, 1, 250, bytes32("inf.v1"), 0, deadline);
        reg.attestWithSig(seller, 0, 1, 250, bytes32("inf.v1"), deadline, v, r, s);
        // Same signature again — nonce is now 1, so verification fails.
        vm.expectRevert("bad signature");
        reg.attestWithSig(seller, 0, 1, 250, bytes32("inf.v1"), deadline, v, r, s);
    }

    /// An old signature cannot be held and used to revert newer metadata: it
    /// expires at its deadline.
    function test_RevertWhen_ExpiredDeadline() public {
        uint64 deadline = uint64(block.timestamp - 1);
        (uint8 v, bytes32 r, bytes32 s) = _sign(0, 1, 250, bytes32("inf.v1"), 0, deadline);
        vm.expectRevert("expired");
        reg.attestWithSig(seller, 0, 1, 250, bytes32("inf.v1"), deadline, v, r, s);
    }

    function test_NonceIncrementsPerAttestation() public {
        uint64 deadline = uint64(block.timestamp + 3600);
        (uint8 v0, bytes32 r0, bytes32 s0) = _sign(0, 1, 250, bytes32("inf.v1"), 0, deadline);
        reg.attestWithSig(seller, 0, 1, 250, bytes32("inf.v1"), deadline, v0, r0, s0);
        assertEq(reg.nonces(seller), 1);
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(0, 0, 120, bytes32("inf.v2"), 1, deadline);
        reg.attestWithSig(seller, 0, 0, 120, bytes32("inf.v2"), deadline, v1, r1, s1);
        assertEq(reg.nonces(seller), 2);
        assertEq(reg.getAttestation(seller).modelClass, 0);
    }

    function test_RevertWhen_BadSig() public {
        bytes32 digest = keccak256("wrong");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        uint64 deadline = uint64(block.timestamp + 3600);
        vm.expectRevert("bad signature");
        reg.attestWithSig(seller, 0, 1, 250, bytes32("inf.v1"), deadline, v, r, s);
    }
}
