// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// Tests for the spending authority. As with `ReceiptMirror`, the interesting
/// cases are the ones a payment must NOT be honoured in: a caller who is not an
/// agent, a payment at the escalation threshold sent on the agent's own
/// authority, one that would cross the period cap, an owner approval replayed, an
/// approval signed by somebody else, one that expired, and one lifted onto a
/// different recipient or amount than the owner actually saw.
///
/// The budget arithmetic gets the same scrutiny, because a cap that silently
/// clamps is worse than no cap: the agent would read a successful smaller payment
/// as the payment it asked for.
contract PolicyWalletTest is Test {
    PolicyWallet internal wallet;
    MockUSDC internal usdc;

    uint256 internal ownerKey = 0xB055;
    address internal ownerAddr;
    uint256 internal impostorKey = 0xBAD;

    address internal agent = address(0xA6E27);
    address internal vendor = address(0x3ED0);

    bytes32 internal INFRA = bytes32("infra");
    bytes32 internal dh = keccak256("decision-1");

    uint256 internal constant USDC1 = 1e6;
    uint64 internal constant MONTH = 30 days;

    function setUp() public {
        ownerAddr = vm.addr(ownerKey);
        usdc = new MockUSDC();

        vm.prank(ownerAddr);
        wallet = new PolicyWallet(address(usdc));

        usdc.mint(address(wallet), 10_000 * USDC1);

        vm.startPrank(ownerAddr);
        wallet.setAgent(agent, true);
        // cap 1000 USDC a month, the agent alone may send up to 100 (exclusive).
        wallet.setBudget(INFRA, 1000 * USDC1, 100 * USDC1, MONTH);
        vm.stopPrank();

        vm.warp(1_785_000_000);
    }

    function _signApproval(
        uint256 key,
        bytes32 category,
        address to,
        uint256 amount,
        bytes32 decisionHash,
        uint256 nonce,
        uint64 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest =
            wallet.approvalDigest(category, to, amount, decisionHash, nonce, deadline);
        (v, r, s) = vm.sign(key, digest);
    }

    // --- the happy path ------------------------------------------------------

    function test_agent_spends_under_the_limit_and_the_vendor_is_paid() public {
        vm.prank(agent);
        wallet.spend(INFRA, vendor, 40 * USDC1, dh);

        assertEq(usdc.balanceOf(vendor), 40 * USDC1, "vendor paid");
        (,, uint256 spent,,,) = wallet.budgetOf(INFRA);
        assertEq(spent, 40 * USDC1, "spend recorded");
        assertEq(wallet.remaining(INFRA), 960 * USDC1, "headroom");
    }

    function test_owner_approval_clears_a_payment_at_the_threshold() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 500 * USDC1, dh, 0, deadline);

        vm.prank(agent);
        wallet.spendApproved(INFRA, vendor, 500 * USDC1, dh, deadline, v, r, s);

        assertEq(usdc.balanceOf(vendor), 500 * USDC1, "large payment cleared by signature");
        assertEq(wallet.approvalNonce(), 1, "nonce consumed");
    }

    function test_the_period_rolls_and_the_cap_refills() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 1000 * USDC1, dh, 0, deadline);
        vm.prank(agent);
        wallet.spendApproved(INFRA, vendor, 1000 * USDC1, dh, deadline, v, r, s);
        assertEq(wallet.remaining(INFRA), 0, "exhausted");

        vm.warp(block.timestamp + MONTH + 1);
        assertEq(wallet.remaining(INFRA), 1000 * USDC1, "new period, full cap");

        vm.prank(agent);
        wallet.spend(INFRA, vendor, 10 * USDC1, dh);
        (,, uint256 spent,,,) = wallet.budgetOf(INFRA);
        assertEq(spent, 10 * USDC1, "the new period starts from zero, not from last month");
    }

    /// A category funded monthly must stay on its own calendar. If the roll moved
    /// `periodStart` to "now" instead of forward by whole periods, a quiet month
    /// would shift every later boundary and the cap would drift off the month.
    function test_the_roll_advances_by_whole_periods_and_does_not_drift() public {
        (,,,, uint64 startBefore,) = wallet.budgetOf(INFRA);

        vm.warp(block.timestamp + (MONTH * 3) + 5 days);
        (,,,, uint64 startAfter,) = wallet.budgetOf(INFRA);

        assertEq(startAfter, startBefore + MONTH * 3, "three whole periods, not 3 months 5 days");
    }

    // --- who may spend ------------------------------------------------------

    function test_a_stranger_cannot_spend() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not agent");
        wallet.spend(INFRA, vendor, 1 * USDC1, dh);
    }

    function test_the_owner_is_not_an_agent_and_spends_by_withdrawing() public {
        vm.prank(ownerAddr);
        vm.expectRevert("not agent");
        wallet.spend(INFRA, vendor, 1 * USDC1, dh);
    }

    function test_a_revoked_agent_stops_spending() public {
        vm.prank(ownerAddr);
        wallet.setAgent(agent, false);

        vm.prank(agent);
        vm.expectRevert("not agent");
        wallet.spend(INFRA, vendor, 1 * USDC1, dh);
    }

    // --- the escalation threshold -------------------------------------------

    /// The documented limit is the first amount the agent may NOT send alone.
    function test_the_threshold_is_exclusive_at_the_boundary() public {
        vm.prank(agent);
        wallet.spend(INFRA, vendor, 100 * USDC1 - 1, dh);

        vm.prank(agent);
        vm.expectRevert("needs owner approval");
        wallet.spend(INFRA, vendor, 100 * USDC1, dh);
    }

    function test_the_agent_cannot_split_a_payment_past_the_cap() public {
        // Ten payments of 99 clear the per-tx limit but the cap still binds.
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(agent);
            wallet.spend(INFRA, vendor, 99 * USDC1, keccak256(abi.encode("d", i)));
        }
        assertEq(wallet.remaining(INFRA), 10 * USDC1, "990 of 1000 spent");

        vm.prank(agent);
        vm.expectRevert("over category budget");
        wallet.spend(INFRA, vendor, 11 * USDC1, dh);
    }

    // --- refuse, never clamp ------------------------------------------------

    function test_a_payment_that_would_cross_the_cap_pays_zero_not_the_headroom() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 995 * USDC1, dh, 0, deadline);
        vm.prank(agent);
        wallet.spendApproved(INFRA, vendor, 995 * USDC1, dh, deadline, v, r, s);

        uint256 before = usdc.balanceOf(vendor);
        assertEq(wallet.remaining(INFRA), 5 * USDC1, "5 of headroom left");

        // 10 is affordable only if the cap clamps. It must not.
        vm.prank(agent);
        vm.expectRevert("over category budget");
        wallet.spend(INFRA, vendor, 10 * USDC1, dh);

        assertEq(usdc.balanceOf(vendor), before, "the headroom was not quietly paid out");
        assertEq(wallet.remaining(INFRA), 5 * USDC1, "and the headroom is still there");
    }

    // --- the decision record is not optional --------------------------------

    function test_a_payment_with_no_decision_hash_is_refused() public {
        vm.prank(agent);
        vm.expectRevert("zero decision hash");
        wallet.spend(INFRA, vendor, 1 * USDC1, bytes32(0));
    }

    function test_zero_recipient_and_zero_amount_are_refused() public {
        vm.prank(agent);
        vm.expectRevert("zero to");
        wallet.spend(INFRA, address(0), 1 * USDC1, dh);

        vm.prank(agent);
        vm.expectRevert("zero amount");
        wallet.spend(INFRA, vendor, 0, dh);
    }

    function test_an_unknown_category_has_no_authority() public {
        vm.prank(agent);
        vm.expectRevert("no such budget");
        wallet.spend(bytes32("travel"), vendor, 1 * USDC1, dh);
    }

    // --- the owner's signature ----------------------------------------------

    function test_an_approval_cannot_be_replayed() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 200 * USDC1, dh, 0, deadline);

        vm.prank(agent);
        wallet.spendApproved(INFRA, vendor, 200 * USDC1, dh, deadline, v, r, s);

        vm.prank(agent);
        vm.expectRevert("not owner signature");
        wallet.spendApproved(INFRA, vendor, 200 * USDC1, dh, deadline, v, r, s);

        assertEq(usdc.balanceOf(vendor), 200 * USDC1, "the vendor was paid exactly once");
    }

    function test_an_impostor_signature_is_refused() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(impostorKey, INFRA, vendor, 200 * USDC1, dh, 0, deadline);

        vm.prank(agent);
        vm.expectRevert("not owner signature");
        wallet.spendApproved(INFRA, vendor, 200 * USDC1, dh, deadline, v, r, s);
    }

    function test_an_expired_approval_is_refused() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 200 * USDC1, dh, 0, deadline);

        vm.warp(block.timestamp + 601);

        vm.prank(agent);
        vm.expectRevert("approval expired");
        wallet.spendApproved(INFRA, vendor, 200 * USDC1, dh, deadline, v, r, s);
    }

    /// The signature binds every field. An approval the owner read as "pay the
    /// vendor 200" must not settle as "pay somebody else 200", or as "pay the
    /// vendor 900" — that is the invoice-fraud case this product is about.
    function test_an_approval_cannot_be_lifted_onto_another_payment() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 200 * USDC1, dh, 0, deadline);

        vm.prank(agent);
        vm.expectRevert("not owner signature");
        wallet.spendApproved(INFRA, address(0xBEEF), 200 * USDC1, dh, deadline, v, r, s);

        vm.prank(agent);
        vm.expectRevert("not owner signature");
        wallet.spendApproved(INFRA, vendor, 900 * USDC1, dh, deadline, v, r, s);

        vm.prank(agent);
        vm.expectRevert("not owner signature");
        wallet.spendApproved(INFRA, vendor, 200 * USDC1, keccak256("other"), deadline, v, r, s);
    }

    /// An approval lifts the per-transaction ceiling, never the budget.
    function test_the_owners_approval_does_not_reopen_the_category_cap() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 1001 * USDC1, dh, 0, deadline);

        vm.prank(agent);
        vm.expectRevert("over category budget");
        wallet.spendApproved(INFRA, vendor, 1001 * USDC1, dh, deadline, v, r, s);
    }

    // --- the kill switch ----------------------------------------------------

    function test_pause_stops_the_agent() public {
        vm.prank(ownerAddr);
        wallet.setPaused(true);

        vm.prank(agent);
        vm.expectRevert("paused");
        wallet.spend(INFRA, vendor, 1 * USDC1, dh);
    }

    /// The kill switch outranks the owner's own signature. A wallet that kept
    /// paying on a signature made before the pause would not be paused.
    function test_pause_stops_even_an_owner_approved_payment() public {
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) =
            _signApproval(ownerKey, INFRA, vendor, 200 * USDC1, dh, 0, deadline);

        vm.prank(ownerAddr);
        wallet.setPaused(true);

        vm.prank(agent);
        vm.expectRevert("paused");
        wallet.spendApproved(INFRA, vendor, 200 * USDC1, dh, deadline, v, r, s);
    }

    // --- configuration ------------------------------------------------------

    function test_a_budget_cannot_be_half_configured() public {
        vm.startPrank(ownerAddr);
        vm.expectRevert("zero cap");
        wallet.setBudget(bytes32("a"), 0, 1, MONTH);
        vm.expectRevert("zero per-tx limit");
        wallet.setBudget(bytes32("a"), 100, 0, MONTH);
        vm.expectRevert("zero period");
        wallet.setBudget(bytes32("a"), 100, 10, 0);
        vm.expectRevert("zero category");
        wallet.setBudget(bytes32(0), 100, 10, MONTH);
        vm.stopPrank();
    }

    /// An unreachable per-transaction limit reads as a limit while enforcing
    /// nothing, so the contract refuses the configuration rather than the payment.
    function test_a_per_tx_limit_above_the_cap_is_refused() public {
        vm.prank(ownerAddr);
        vm.expectRevert("per-tx limit above cap");
        wallet.setBudget(bytes32("a"), 100 * USDC1, 101 * USDC1, MONTH);
    }

    function test_only_the_owner_configures() public {
        vm.startPrank(agent);
        vm.expectRevert("not owner");
        wallet.setBudget(INFRA, 1, 1, 1);
        vm.expectRevert("not owner");
        wallet.setAgent(address(0xFEE), true);
        vm.expectRevert("not owner");
        wallet.setPaused(true);
        vm.expectRevert("not owner");
        wallet.withdraw(agent, 1);
        vm.stopPrank();
    }

    function test_the_owner_can_always_retrieve_their_own_money() public {
        vm.prank(ownerAddr);
        wallet.withdraw(ownerAddr, 2_000 * USDC1);
        assertEq(usdc.balanceOf(ownerAddr), 2_000 * USDC1, "not constrained by a category cap");
    }

    function test_ownership_moves_in_two_steps() public {
        address next = address(0x0FFE);

        vm.prank(ownerAddr);
        wallet.transferOwnership(next);
        assertEq(wallet.owner(), ownerAddr, "not yet");

        vm.prank(address(0xDEAD));
        vm.expectRevert("not pending owner");
        wallet.acceptOwnership();

        vm.prank(next);
        wallet.acceptOwnership();
        assertEq(wallet.owner(), next, "transferred");
        assertEq(wallet.pendingOwner(), address(0), "cleared");
    }

    // --- the owner's own wallet, which is the threshold made literal --------

    function test_the_owner_pays_an_escalated_obligation_from_their_own_wallet() public {
        uint256 before = usdc.balanceOf(vendor);

        vm.prank(ownerAddr);
        wallet.spendAsOwner(INFRA, vendor, 500 * USDC1, dh);

        assertEq(usdc.balanceOf(vendor), before + 500 * USDC1, "paid");
        (,, uint256 spent,,,) = wallet.budgetOf(INFRA);
        assertEq(spent, 500 * USDC1, "and it counts against the budget");
    }

    /// The per-transaction limit bounds the AGENT. The owner is the escalation
    /// path, so a limit that also bound them would leave nothing above it.
    function test_the_per_transaction_limit_does_not_bind_the_owner() public {
        vm.prank(agent);
        vm.expectRevert("needs owner approval");
        wallet.spend(INFRA, vendor, 500 * USDC1, dh);

        vm.prank(ownerAddr);
        wallet.spendAsOwner(INFRA, vendor, 500 * USDC1, dh);
        assertEq(usdc.balanceOf(vendor), 500 * USDC1, "the same payment, by the owner");
    }

    /// If an agent could reach this path the threshold would be a suggestion.
    function test_an_agent_cannot_reach_the_owners_path() public {
        vm.prank(agent);
        vm.expectRevert("not owner");
        wallet.spendAsOwner(INFRA, vendor, 500 * USDC1, dh);
    }

    function test_a_stranger_cannot_reach_the_owners_path() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not owner");
        wallet.spendAsOwner(INFRA, vendor, 1 * USDC1, dh);
    }

    /// The kill switch outranks the owner's own wallet, not just their signature.
    function test_pause_stops_the_owner_too() public {
        vm.prank(ownerAddr);
        wallet.setPaused(true);

        vm.prank(ownerAddr);
        vm.expectRevert("paused");
        wallet.spendAsOwner(INFRA, vendor, 1 * USDC1, dh);
    }

    /// The cap IS the budget. An owner paying one invoice must not undo an owner
    /// closing a category; `setBudget` is how a budget changes, on the record.
    function test_the_cap_still_binds_the_owner() public {
        vm.prank(ownerAddr);
        vm.expectRevert("over category budget");
        wallet.spendAsOwner(INFRA, vendor, 1001 * USDC1, dh);
    }

    function test_the_owners_path_still_requires_a_payee_an_amount_and_a_reason() public {
        vm.startPrank(ownerAddr);
        vm.expectRevert("zero to");
        wallet.spendAsOwner(INFRA, address(0), 1 * USDC1, dh);
        vm.expectRevert("zero amount");
        wallet.spendAsOwner(INFRA, vendor, 0, dh);
        vm.expectRevert("zero decision hash");
        wallet.spendAsOwner(INFRA, vendor, 1 * USDC1, bytes32(0));
        vm.stopPrank();
    }

    function test_an_unknown_category_has_no_authority_even_for_the_owner() public {
        vm.prank(ownerAddr);
        vm.expectRevert("no such budget");
        wallet.spendAsOwner(bytes32("travel"), vendor, 1 * USDC1, dh);
    }

    /// The record has to say a human did this, and name which one.
    function test_the_event_records_a_human_decision_and_names_the_actor() public {
        vm.recordLogs();
        vm.prank(ownerAddr);
        wallet.spendAsOwner(INFRA, vendor, 200 * USDC1, dh);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            // Spent(bytes32 indexed, address indexed, address indexed, ...)
            if (logs[i].topics[0] == keccak256(
                "Spent(bytes32,address,address,uint256,bytes32,bool,uint256,uint256,uint64)"
            )) {
                found = true;
                assertEq(
                    address(uint160(uint256(logs[i].topics[3]))), ownerAddr,
                    "the actor is the owner, not an agent"
                );
                (, , bool ownerApproved, , ,) =
                    abi.decode(logs[i].data, (uint256, bytes32, bool, uint256, uint256, uint64));
                assertTrue(ownerApproved, "recorded as a human decision");
            }
        }
        assertTrue(found, "no Spent event");
    }
}

