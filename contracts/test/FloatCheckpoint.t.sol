// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FloatVault} from "../src/float/FloatVault.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";
import {ISleeve} from "../src/float/IFloat.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {RecordingSleeve} from "./float/Doubles.sol";

/// @notice The human path: a spend the agent may not make on its own is parked
///         on chain and released by one signature that fits one request once.
///
///         The containment claim being tested is narrow and worth stating
///         exactly, because it is what makes handing a signing key to a backend
///         defensible: the approver key can release a spend whose exact hash
///         THIS CONTRACT opened, inside its TTL, once. It cannot invent a spend,
///         re-aim an approval at another payment, change an amount, outlive its
///         window, or reach past the frozen / band / cap checks. Every clause in
///         that sentence has a test below.
contract FloatCheckpointTest is Test {
    MockUSDC usdc;
    FloatPrintStore store;
    FloatVault vault;
    RecordingSleeve sleeve;

    uint256 constant APPROVER_PK = 0xA11CE;
    address approver;

    address executor = address(0xE1);
    address keeper = address(0xE2);
    address seller = address(0x5E11E7);

    bytes32 constant SCOUT = keccak256("scout");
    bytes32 constant INDEX = keccak256("ACR-INF:model-a");
    uint256 constant PRICE_WAD = 2e15;
    uint256 constant UNITS = 6_000;
    uint256 constant FAIR = 12e6;
    uint64 constant TTL = 300;

    function setUp() public {
        approver = vm.addr(APPROVER_PK);

        usdc = new MockUSDC();
        store = new FloatPrintStore();
        store.setSigner(keeper, true);

        vault = new FloatVault(address(usdc), address(store), 2e6);
        sleeve = new RecordingSleeve(usdc, address(vault));
        sleeve.watch(seller);
        vault.wire(executor, keeper, approver, address(0xE4), address(0xE5), sleeve, ISleeve(address(0)));

        vault.setPolicy(
            FloatVault.Policy({
                maxPremiumBps: 100, // agent: 1% over fair
                humanMaxPremiumBps: 2000, // human: 20% over fair
                maxPrintAge: 1800,
                upperBandBps: 1500,
                lowerBandBps: 1000,
                workingShareBps: 3000,
                bufferHours: 48,
                minTicketUsdc: 25e6
            }),
            keccak256("cfg"),
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
        // perRequest 10 USDC, so a 12 USDC fair purchase is ABOVE the agent's
        // own authority and must be parked rather than refused.
        vault.setAgent(SCOUT, 100e6, 10e6, false, keccak256("cfg"), 0, 0, bytes32(0), bytes32(0));
        vault.allowSeller(SCOUT, seller, true, 0, 0, bytes32(0), bytes32(0));

        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 500);
        usdc.mint(address(vault), 100e6);
    }

    function _req(uint256 quote, bytes32 nonce)
        internal
        view
        returns (FloatVault.SpendReq memory)
    {
        (, uint64 pid,,) = store.latest(INDEX);
        return FloatVault.SpendReq({
            agentId: SCOUT,
            seller: seller,
            index: INDEX,
            units: UNITS,
            quoteTotal: quote,
            printId: pid,
            nonce: nonce
        });
    }

    function _open(FloatVault.SpendReq memory r) internal returns (uint256 id) {
        // Hash first: `hashSpendReq` is an external call and would otherwise
        // consume the prank meant for `openCheckpoint`.
        bytes32 h = vault.hashSpendReq(r);
        vm.prank(executor);
        return vault.openCheckpoint(SCOUT, h, 1, TTL);
    }

    function _sign(uint256 pk, uint256 id, bytes32 reqHash)
        internal
        view
        returns (uint8 v, bytes32 rs, bytes32 ss)
    {
        (, uint64 expiresAt,,,) = vault.checkpoints(id);
        bytes32 digest = vault.approvalDigest(id, reqHash, expiresAt, vault.treasurerBinding());
        return vm.sign(pk, digest);
    }

    // --- the threshold is real ----------------------------------------------

    function test_a_spend_above_the_threshold_is_parked_not_refused() public {
        (, uint8 code,,) = vault.classify(_req(FAIR, "n1"));
        assertEq(code, vault.D_PER_REQUEST(), "over the agent's own authority");
    }

    function test_opening_a_checkpoint_moves_nothing() public {
        _open(_req(FAIR, "n1"));
        assertEq(usdc.balanceOf(seller), 0, "the seller is untouched while a human decides");
        assertEq(vault.receiptCount(), 0);
    }

    /// THE flow a backend actually writes: ask, be told a human must decide,
    /// park THAT request, execute it. An earlier draft burned the nonce on every
    /// refusal, so this reverted "replayed request" — a refusal naming the wrong
    /// problem, which is the most expensive kind of wrong error message. Caught
    /// by the session building the human gate against this contract, not by the
    /// contract's own tests, because the tests parked without asking first.
    function test_an_escalation_survives_request_spend_and_can_still_be_executed() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        vm.prank(executor);
        (bool ok,) = vault.requestSpend(r);
        assertFalse(ok, "parked, not paid");
        assertEq(usdc.balanceOf(seller), 0);

        uint256 id = _open(r);
        bytes32 h = vault.hashSpendReq(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, h);
        vm.prank(executor);
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), FAIR, "the same request, released by a human");
    }

    /// The exception is narrow: a refusal that is NOT an escalation still burns
    /// its nonce, so it cannot come back when a price moves.
    function test_a_band_refusal_still_burns_its_nonce() public {
        FloatVault.SpendReq memory r = _req(FAIR * 3, "n1");
        vm.prank(executor);
        vault.requestSpend(r);
        (, uint8 code,,) = vault.classify(r);
        assertEq(code, vault.D_REPLAY(), "finished, not parkable");
    }

    // --- the approval --------------------------------------------------------

    function test_a_valid_approval_executes_once_and_is_flagged_as_human() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.prank(executor);
        uint256 receiptId = vault.executeApproved(id, r, v, rs, ss);

        assertEq(receiptId, 1);
        assertEq(usdc.balanceOf(seller), FAIR, "the seller was paid");
        (,,, uint8 status,) = vault.checkpoints(id);
        assertEq(status, 1, "consumed");
    }

    function test_an_approval_cannot_be_replayed() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.prank(executor);
        vault.executeApproved(id, r, v, rs, ss);

        vm.prank(executor);
        vm.expectRevert(bytes("checkpoint closed"));
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), FAIR, "paid once");
    }

    /// The signature is bound to the request hash, so it cannot be lifted onto a
    /// different payment — the same property `PolicyWallet` calls out.
    function test_an_approval_cannot_be_lifted_onto_another_payment() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        FloatVault.SpendReq memory other = _req(FAIR, "n2"); // a different nonce
        vm.prank(executor);
        vm.expectRevert(bytes("request changed"));
        vault.executeApproved(id, other, v, rs, ss);
    }

    function test_an_expired_checkpoint_cannot_be_executed() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.warp(block.timestamp + TTL + 1);
        vm.prank(executor);
        vm.expectRevert(bytes("checkpoint expired"));
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), 0);
    }

    function test_an_impostor_signature_is_refused() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(0xBADBAD, id, vault.hashSpendReq(r));

        vm.prank(executor);
        vm.expectRevert(bytes("bad approval"));
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), 0);
    }

    /// `ecrecover` yields the zero address for a malformed signature, so an
    /// unset approver would make every piece of garbage a valid approval.
    function test_garbage_is_not_an_approval_when_no_approver_is_set() public {
        vault.setApprover(address(0));
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);

        vm.prank(executor);
        vm.expectRevert(bytes("no approver"));
        vault.executeApproved(id, r, 27, bytes32(uint256(1)), bytes32(uint256(1)));
    }

    /// Changing who the treasury is bound to changes the digest, so an approval
    /// signed for one identity does not survive a re-binding.
    function test_a_binding_change_invalidates_an_approval() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vault.setTreasurerBinding(keccak256("someone-else"));
        vm.prank(executor);
        vm.expectRevert(bytes("bad approval"));
        vault.executeApproved(id, r, v, rs, ss);
    }

    // --- the approval widens the band, it does not remove it -----------------

    function test_a_human_approval_widens_the_band() public {
        // 15% over fair: past the agent's 1%, inside the human 20%.
        uint256 quote = FAIR * 115 / 100;
        FloatVault.SpendReq memory r = _req(quote, "n1");
        (, uint8 code,,) = vault.classify(r);
        assertEq(code, vault.D_BAND(), "the agent may not pay this");

        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));
        vm.prank(executor);
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), quote, "a human may");
    }

    function test_a_human_approval_does_not_remove_the_band() public {
        // 3x fair: past the human band too. No signature authorises this.
        FloatVault.SpendReq memory r = _req(FAIR * 3, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.prank(executor);
        vm.expectRevert(bytes("quote exceeds ACR fair band"));
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), 0);
    }

    function test_a_human_approval_cannot_unfreeze_an_agent() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vault.setAgent(SCOUT, 100e6, 10e6, true, keccak256("cfg"), 0, 0, bytes32(0), bytes32(0));
        vm.prank(executor);
        vm.expectRevert(bytes("agent frozen by policy"));
        vault.executeApproved(id, r, v, rs, ss);
    }

    function test_a_human_approval_cannot_exceed_the_daily_cap() public {
        vault.setAgent(SCOUT, 10e6, 9e6, false, keccak256("cfg"), 0, 0, bytes32(0), bytes32(0));
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.prank(executor);
        vm.expectRevert(bytes("daily cap exceeded"));
        vault.executeApproved(id, r, v, rs, ss);
    }

    /// The request hash covers `printId`, so an approval dies when the price
    /// rotates: the human approved a number, not a blank cheque.
    function test_a_human_approval_does_not_survive_a_print_rotation() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 500);

        vm.prank(executor);
        vm.expectRevert(bytes("print changed; re-quote"));
        vault.executeApproved(id, r, v, rs, ss);
    }

    // --- the unsuccessful outcomes are evidence ------------------------------

    function test_a_denial_is_recorded_on_chain_and_moves_nothing() public {
        uint256 id = _open(_req(FAIR, "n1"));
        vm.prank(executor);
        vm.expectEmit(true, true, false, true, address(vault));
        emit FloatVault.CheckpointResolved(id, 2, "treasurer declined");
        vault.resolveCheckpoint(id, 2, "treasurer declined");

        (,,, uint8 status,) = vault.checkpoints(id);
        assertEq(status, 2);
        assertEq(usdc.balanceOf(seller), 0, "seller balance: unchanged");
    }

    function test_a_resolved_checkpoint_cannot_then_be_approved() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vm.prank(executor);
        vault.resolveCheckpoint(id, 2, "declined");
        vm.prank(executor);
        vm.expectRevert(bytes("checkpoint closed"));
        vault.executeApproved(id, r, v, rs, ss);
    }

    function test_only_the_executor_can_open_or_resolve() public {
        bytes32 h = vault.hashSpendReq(_req(FAIR, "n1"));
        vm.expectRevert(bytes("not executor"));
        vault.openCheckpoint(SCOUT, h, 1, TTL);

        uint256 id = _open(_req(FAIR, "n2"));
        vm.expectRevert(bytes("not executor"));
        vault.resolveCheckpoint(id, 2, "nope");
    }

    function test_a_spend_approval_cannot_be_used_as_a_policy_approval() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        uint256 id = _open(r); // kind 1 = spend
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, vault.hashSpendReq(r));

        vault.setPolicyCheckpointRequired(true, 0, 0, bytes32(0), bytes32(0));
        bytes32 h = vault.hashSpendReq(r);
        vm.expectRevert(bytes("wrong checkpoint kind"));
        vault.setAgent(SCOUT, 1e9, 1e9, false, h, id, v, rs, ss);
    }

    /// With the gate on, the compiler waits for a human — and turning the gate
    /// back off needs one too, or the gate is a suggestion.
    function test_the_policy_gate_cannot_be_switched_off_without_a_human() public {
        vault.setPolicyCheckpointRequired(true, 0, 0, bytes32(0), bytes32(0));
        assertTrue(vault.requirePolicyCheckpoint());

        vm.expectRevert(bytes("no such checkpoint"));
        vault.setPolicyCheckpointRequired(false, 999, 27, bytes32(uint256(1)), bytes32(uint256(1)));
    }

    function test_a_policy_change_lands_with_an_approval_when_the_gate_is_on() public {
        vault.setPolicyCheckpointRequired(true, 0, 0, bytes32(0), bytes32(0));
        // The hash is DERIVED from the numbers, so this is what a human signs.
        bytes32 cfg = vault.agentApprovalHash(SCOUT, 77e6, 7e6, false);

        vm.prank(executor);
        uint256 id = vault.openCheckpoint(bytes32(0), cfg, 2, TTL); // kind 2 = policy
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, cfg);

        vault.setAgent(SCOUT, 77e6, 7e6, false, keccak256("provenance"), id, v, rs, ss);
        (, uint256 cap,,,,,) = vault.agentOf(SCOUT);
        assertEq(cap, 77e6, "the policy landed only after the human signed");
    }

    function test_a_policy_change_is_refused_without_an_approval_when_the_gate_is_on() public {
        vault.setPolicyCheckpointRequired(true, 0, 0, bytes32(0), bytes32(0));
        vm.expectRevert(bytes("no such checkpoint"));
        vault.setAgent(
            SCOUT, 77e6, 7e6, false, keccak256("new-config"), 999, 27, bytes32(uint256(1)), bytes32(uint256(1))
        );
    }

    // --- what the Arc Studio audit found -------------------------------------

    /// F1, the one that mattered. An approval has to authorise the NUMBERS, not
    /// merely the moment. `setAgent` and `setPolicy` used to pass the CALLER's
    /// own `configHash` into the approval check, so a signature obtained for
    /// "scout's cap becomes 77 USDC" released any later call carrying that same
    /// hash — including one setting the cap a thousand times higher. The human
    /// saw one policy and authorised another, and nothing on chain disagreed.
    function test_an_approval_for_one_policy_cannot_set_a_different_one() public {
        vault.setPolicyCheckpointRequired(true, 0, 0, bytes32(0), bytes32(0));

        bytes32 shown = vault.agentApprovalHash(SCOUT, 77e6, 7e6, false);
        vm.prank(executor);
        uint256 id = vault.openCheckpoint(bytes32(0), shown, 2, TTL);
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, shown);

        vm.expectRevert(bytes("request changed"));
        vault.setAgent(SCOUT, 77_000e6, 7_000e6, false, keccak256("prov"), id, v, rs, ss);

        // The numbers that were actually shown still go through.
        vault.setAgent(SCOUT, 77e6, 7e6, false, keccak256("prov"), id, v, rs, ss);
        (, uint256 cap,,,,,) = vault.agentOf(SCOUT);
        assertEq(cap, 77e6);
    }

    /// The checkpoint announces an agent in `CheckpointOpened`, and our own
    /// dashboard and the approval signer both read it. It used to be emitted
    /// and never stored, so the event could name one agent while the request
    /// hash committed to another.
    function test_a_checkpoint_opened_for_one_agent_cannot_release_anothers_payment() public {
        FloatVault.SpendReq memory r = _req(FAIR, "n1"); // this request is scout's
        bytes32 h = vault.hashSpendReq(r);
        vm.prank(executor);
        uint256 id = vault.openCheckpoint(keccak256("waster"), h, 1, TTL); // announced as waster
        (uint8 v, bytes32 rs, bytes32 ss) = _sign(APPROVER_PK, id, h);

        vm.prank(executor);
        vm.expectRevert(bytes("agent mismatch"));
        vault.executeApproved(id, r, v, rs, ss);
        assertEq(usdc.balanceOf(seller), 0);
    }

    /// Status 0 means both OPEN and never-opened. `_consumeApproval` guarded
    /// that with a non-zero reqHash; `resolveCheckpoint` did not, so a
    /// fabricated id could emit a `CheckpointResolved` for a decision nobody
    /// ever made — a forged entry in the public record.
    function test_a_checkpoint_that_was_never_opened_cannot_be_resolved() public {
        vm.prank(executor);
        vm.expectRevert(bytes("no such checkpoint"));
        vault.resolveCheckpoint(999, 2, "treasurer declined");
    }
}
