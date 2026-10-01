// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @dev Drives the wallet with only *authorized, affordable* payments: the agent
///      path is bounded strictly below the per-transaction limit, the approved
///      path carries a fresh owner signature over the current nonce, and both are
///      bounded by the headroom the contract itself reports. Time advances
///      between calls so the period roll is exercised rather than assumed.
///
///      With `fail_on_revert = true` that matters: a revert here would mean the
///      handler built an invalid call, which would hide the invariants behind
///      mostly-rejected sequences instead of running them against real spending
///      state. Where no legal payment exists the handler returns instead.
contract PolicyWalletHandler is Test {
    PolicyWallet public wallet;
    MockUSDC public usdc;
    bytes32 public constant INFRA = bytes32("infra");

    uint256 internal ownerKey;

    /// Everything the invariants compare the contract against, accumulated here
    /// rather than read back from it, so the two are independent.
    uint256 public totalPaid;
    uint256 public approvedSpends;
    uint256 public agentSpends;

    constructor(PolicyWallet _wallet, MockUSDC _usdc, uint256 _ownerKey) {
        wallet = _wallet;
        usdc = _usdc;
        ownerKey = _ownerKey;
    }

    function _headroom() internal view returns (uint256) {
        return wallet.remaining(INFRA);
    }

    /// The agent's own authority.
    function spend(uint256 amount, uint256 dt, uint256 seed) external {
        vm.warp(block.timestamp + bound(dt, 1, 5 days));

        (,,, uint256 perTxLimit,,) = wallet.budgetOf(INFRA);
        uint256 room = _headroom();
        uint256 ceiling = perTxLimit - 1; // strictly below the threshold
        if (room < ceiling) ceiling = room;
        if (ceiling == 0) return;

        amount = bound(amount, 1, ceiling);
        wallet.spend(INFRA, address(uint160(uint256(keccak256(abi.encode(seed))))), amount,
            keccak256(abi.encode("decision", seed, amount)));

        totalPaid += amount;
        agentSpends++;
    }

    /// The path that needs a human. Signed here over the live nonce, so a stale
    /// signature is never submitted and the revert-free contract is honest.
    function spendApproved(uint256 amount, uint256 dt, uint256 seed) external {
        vm.warp(block.timestamp + bound(dt, 1, 5 days));

        uint256 room = _headroom();
        if (room == 0) return;
        amount = bound(amount, 1, room);

        address to = address(uint160(uint256(keccak256(abi.encode("to", seed)))));
        if (to == address(0)) return;
        bytes32 dh = keccak256(abi.encode("approved", seed, amount));
        uint64 deadline = uint64(block.timestamp + 1 hours);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ownerKey,
            wallet.approvalDigest(INFRA, to, amount, dh, wallet.approvalNonce(), deadline)
        );
        wallet.spendApproved(INFRA, to, amount, dh, deadline, v, r, s);

        totalPaid += amount;
        approvedSpends++;
    }
}

contract PolicyWalletInvariantTest is Test {
    PolicyWallet internal wallet;
    MockUSDC internal usdc;
    PolicyWalletHandler internal handler;

    bytes32 internal constant INFRA = bytes32("infra");
    uint256 internal constant FUNDED = 1e18; // far past any reachable spend
    uint256 internal constant CAP = 1_000 * 1e6;
    uint256 internal constant PER_TX = 100 * 1e6;
    uint64 internal constant MONTH = 30 days;

    uint256 internal ownerKey = 0xB055;

    function setUp() public {
        vm.warp(1_785_000_000);
        address ownerAddr = vm.addr(ownerKey);

        usdc = new MockUSDC();
        vm.prank(ownerAddr);
        wallet = new PolicyWallet(address(usdc));
        usdc.mint(address(wallet), FUNDED);

        handler = new PolicyWalletHandler(wallet, usdc, ownerKey);

        vm.startPrank(ownerAddr);
        wallet.setAgent(address(handler), true);
        wallet.setBudget(INFRA, CAP, PER_TX, MONTH);
        vm.stopPrank();

        targetContract(address(handler));
    }

    /// The budget is the whole claim of the contract.
    function invariant_spent_never_exceeds_the_cap() public view {
        (,, uint256 spent,,,) = wallet.budgetOf(INFRA);
        assertLe(spent, CAP, "a period spent more than its cap");
    }

    /// The accounting identity. If these two ever disagree, the number shown to
    /// the owner and the number the contract enforces have come apart.
    function invariant_remaining_and_spent_account_for_the_cap() public view {
        (,, uint256 spent,,,) = wallet.budgetOf(INFRA);
        assertEq(wallet.remaining(INFRA) + spent, CAP, "remaining + spent != cap");
    }

    /// Conservation: every USDC that left the wallet left through a payment the
    /// handler made. Anything else means value escaped the authority ladder.
    function invariant_the_wallet_only_lost_what_it_paid_out() public view {
        assertEq(
            usdc.balanceOf(address(wallet)),
            FUNDED - handler.totalPaid(),
            "wallet balance does not match the payments made"
        );
    }

    /// One nonce, one approved payment. This is the duplicate-payment guard
    /// stated as an invariant rather than as a single test.
    function invariant_one_nonce_per_approved_payment() public view {
        assertEq(
            wallet.approvalNonce(),
            handler.approvedSpends(),
            "an owner approval was consumed more or less than once"
        );
    }

    /// The agent's unilateral payments never reach the threshold. Enforced by
    /// construction in the handler, asserted here so a change to either side has
    /// to confront the other.
    function invariant_the_threshold_still_separates_the_two_paths() public view {
        (,,, uint256 perTxLimit,,) = wallet.budgetOf(INFRA);
        assertEq(perTxLimit, PER_TX, "the threshold moved");
    }
}
