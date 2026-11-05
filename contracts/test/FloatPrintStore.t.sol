// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";

/// @notice The price feed a spend is bound to. Its whole job is to make two
///         refusals independently enforceable — "this print is too old" and
///         "this print is not the one you were quoted" — which is why a print
///         has an id at all.
contract FloatPrintStoreTest is Test {
    FloatPrintStore store;
    address keeper = address(0xCEE);
    address stranger = address(0x5721);

    string constant NAME = "ACR-INF:meta-llama/llama-3.3-70b-instruct";
    bytes32 immutable INDEX = keccak256(bytes("ACR-INF:meta-llama/llama-3.3-70b-instruct"));
    bytes32 immutable OTHER = keccak256(bytes("ACR-INF:openai/gpt-4o-mini"));

    uint256 constant PRICE_WAD = 640_000_000_000_000; // $0.00064 per 1k tokens

    function setUp() public {
        store = new FloatPrintStore();
        store.setSigner(keeper, true);
    }

    function _print(bytes32 index, uint256 price, uint32 ci) internal returns (uint64) {
        vm.prank(keeper);
        return store.setPrint(index, price, ci);
    }

    // --- identity ------------------------------------------------------------

    function test_a_print_gets_an_incrementing_id_per_index() public {
        assertEq(_print(INDEX, PRICE_WAD, 3437), 1);
        assertEq(_print(INDEX, PRICE_WAD, 3437), 2);
        assertEq(_print(INDEX, PRICE_WAD, 3437), 3);
    }

    /// Two indices written in the same block share a timestamp, which is exactly
    /// why `postedAt` cannot serve as identity and an id can.
    function test_two_indices_keep_separate_id_sequences() public {
        _print(INDEX, PRICE_WAD, 100);
        _print(INDEX, PRICE_WAD, 100);
        assertEq(_print(OTHER, PRICE_WAD, 100), 1, "a fresh index starts at one");

        (, uint64 a, uint64 ta,) = store.latest(INDEX);
        (, uint64 b, uint64 tb,) = store.latest(OTHER);
        assertEq(a, 2);
        assertEq(b, 1);
        assertEq(ta, tb, "same block, same timestamp: the ids are what differ");
    }

    /// The vault has to be able to refuse "no print for index" as a normal
    /// refusal with its own sentence. A reverting view would turn that into a
    /// failed transaction carrying no event at all.
    function test_an_unprinted_index_reads_as_zero_rather_than_reverting() public view {
        (uint256 price, uint64 id, uint64 at, uint32 ci) = store.latest(keccak256("never"));
        assertEq(price, 0);
        assertEq(id, 0, "id zero IS the absence signal");
        assertEq(at, 0);
        assertEq(ci, 0);

        (bool exists,,) = store.latestPrintPrimitive(keccak256("never"));
        assertFalse(exists);
    }

    function test_absence_counts_as_stale() public {
        assertTrue(store.isStale(keccak256("never"), 1 hours), "no print is not a fresh print");
        _print(INDEX, PRICE_WAD, 100);
        assertFalse(store.isStale(INDEX, 1 hours));
        vm.warp(block.timestamp + 2 hours);
        assertTrue(store.isStale(INDEX, 1 hours));
    }

    function test_history_keeps_every_print_so_a_receipt_stays_checkable() public {
        _print(INDEX, 1e15, 100);
        _print(INDEX, 2e15, 200);
        assertEq(store.historyLength(INDEX), 2);

        FloatPrintStore.Print memory first = store.historyAt(INDEX, 0);
        assertEq(first.priceWad, 1e15, "the price a receipt cited is still there");
        assertEq(first.printId, 1);
        vm.expectRevert(bytes("out of range"));
        store.historyAt(INDEX, 2);
    }

    function test_the_store_enumerates_what_it_has_printed() public {
        _print(INDEX, PRICE_WAD, 100);
        _print(INDEX, PRICE_WAD, 100);
        _print(OTHER, PRICE_WAD, 100);
        assertEq(store.indexCount(), 2, "two indices, three prints");
        assertEq(store.indexAt(0), INDEX);
        assertEq(store.indexAt(1), OTHER);
    }

    // --- naming --------------------------------------------------------------

    /// An id is keccak256(name) because the name does not fit in 32 bytes — the
    /// one in this test is 41. The store CHECKS the relation rather than
    /// trusting the signer, so a cheap model's price cannot be relabelled as an
    /// expensive one's.
    function test_an_index_name_must_hash_to_its_own_id() public {
        assertEq(bytes(NAME).length, 41, "too long for a bytes32, hence the hash");
        vm.prank(keeper);
        store.nameIndex(INDEX, NAME);
        assertEq(store.indexName(INDEX), NAME);

        vm.prank(keeper);
        vm.expectRevert(bytes("name is not this index"));
        store.nameIndex(OTHER, NAME);
    }

    function test_an_index_is_named_once_and_not_rewritten() public {
        vm.prank(keeper);
        store.nameIndex(INDEX, NAME);
        vm.prank(keeper);
        vm.expectRevert(bytes("already named"));
        store.nameIndex(INDEX, NAME);
    }

    function test_only_a_signer_may_name_an_index() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("not signer"));
        store.nameIndex(INDEX, NAME);
    }

    // --- authority -----------------------------------------------------------

    function test_only_a_signer_may_print() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("not signer"));
        store.setPrint(INDEX, PRICE_WAD, 100);
    }

    function test_a_revoked_signer_stops_printing_without_stopping_the_others() public {
        address second = address(0xBEE);
        store.setSigner(second, true);
        _print(INDEX, PRICE_WAD, 100);
        store.setSigner(keeper, false);

        vm.prank(keeper);
        vm.expectRevert(bytes("not signer"));
        store.setPrint(INDEX, PRICE_WAD, 100);

        vm.prank(second);
        assertEq(store.setPrint(INDEX, PRICE_WAD, 100), 2, "the other signer carries on");
    }

    function test_a_paused_store_refuses_a_print() public {
        store.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(bytes("paused"));
        store.setPrint(INDEX, PRICE_WAD, 100);
    }

    /// Pausing used to block WRITES only, so after a bad print the store kept
    /// serving it for up to the vault's whole maxPrintAge and the only real
    /// remedy was pausing the vault instead. A store that cannot be silenced is
    /// not an incident-response lever. Reporting id 0 routes every consumer
    /// down the path it already has for "no print for index".
    function test_pausing_the_store_silences_its_reads_not_just_its_writes() public {
        _print(INDEX, PRICE_WAD, 500);
        (, uint64 idBefore,,) = store.latest(INDEX);
        assertEq(idBefore, 1, "a print is being served");

        store.setPaused(true);
        (uint256 price, uint64 id, uint64 at, uint32 ci) = store.latest(INDEX);
        assertEq(id, 0, "paused reads as absent, which the vault already refuses");
        assertEq(price, 0);
        assertEq(at, 0);
        assertEq(ci, 0);
        (bool exists,,) = store.latestPrintPrimitive(INDEX);
        assertFalse(exists);
        assertTrue(store.isStale(INDEX, 1 hours), "and never fresh while paused");

        store.setPaused(false);
        (, uint64 back,,) = store.latest(INDEX);
        assertEq(back, 1, "unpausing restores the same print, it is not destroyed");
    }

    function test_a_zero_price_is_not_a_price() public {
        vm.prank(keeper);
        vm.expectRevert(bytes("zero price"));
        store.setPrint(INDEX, 0, 100);
    }

    /// The forecaster multiplies the buffer by (1 + ci), so an unbounded ci is
    /// an unbounded buffer. A spread wider than the price means the fetch is
    /// wrong, not that the market is volatile.
    function test_a_confidence_interval_wider_than_the_price_is_refused() public {
        vm.prank(keeper);
        vm.expectRevert(bytes("ci too wide"));
        store.setPrint(INDEX, PRICE_WAD, 10_001);

        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 10_000); // the boundary is allowed
    }

    function test_ownership_moves_in_two_steps() public {
        address next = address(0xA11);
        store.transferOwnership(next);
        assertEq(store.owner(), address(this), "not yet");
        vm.prank(next);
        store.acceptOwnership();
        assertEq(store.owner(), next);
    }
}
