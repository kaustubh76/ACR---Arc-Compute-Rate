// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {UsycSleeve} from "../src/float/UsycSleeve.sol";
import {FloatVault} from "../src/float/FloatVault.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";
import {ISleeve} from "../src/float/IFloat.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {RecordingSleeve} from "./float/Doubles.sol";
import {SimUsyc, SimUsycTeller} from "../src/sim/SimUsyc.sol";
import {IERC20} from "../src/float/IFloat.sol";

/// @notice The reserve leg: idle float in Circle's tokenised treasury fund.
///
/// The original design called for three sleeves and shipped two. This is the
/// third, and it is DEPLOYABLE BUT NOT FUNDABLE today — Circle's allowlist is a
/// support ticket, not a contract change. Verified on Arc Testnet the day this
/// was written: a staticcall of `deposit` from our deployer reverts
/// `0x7f63bd0f`, which the Teller's verified ABI names `NotPermissioned()`.
///
/// So everything here runs against a double shaped from that verified ABI. The
/// point is that when the ticket clears, funding it is a deployment step and
/// not a development one.
contract UsycSleeveTest is Test {
    MockUSDC usdc;
    SimUsyc usyc;
    SimUsycTeller teller;
    UsycSleeve sleeve;

    address treasury = address(0x7EA);

    function setUp() public {
        usdc = new MockUSDC();
        usyc = new SimUsyc();
        teller = new SimUsycTeller(IERC20(address(usdc)), usyc);
        sleeve = new UsycSleeve(address(teller), address(usdc), address(usyc), treasury);
        // The Teller needs USDC to pay redemptions out of.
        usdc.mint(address(teller), 1_000e6);
    }

    function _fundTreasury(uint256 a) internal {
        usdc.mint(treasury, a);
        vm.prank(treasury);
        usdc.approve(address(sleeve), a);
    }

    function _park(uint256 a) internal {
        _fundTreasury(a);
        teller.setPermissioned(true);
        vm.prank(treasury);
        sleeve.depositIdle(a);
    }

    // --- the state we are actually in ---------------------------------------

    /// THIS IS TODAY. Until the allowlist lands, every deposit reverts exactly
    /// this way, and the acceptance suite reports it live rather than assuming.
    function test_an_unpermissioned_teller_refuses_the_deposit_by_name() public {
        _fundTreasury(100e6);
        // permissioned defaults to false, which is our real standing.
        vm.prank(treasury);
        vm.expectRevert(SimUsycTeller.NotPermissioned.selector);
        sleeve.depositIdle(100e6);
    }

    /// THE TRAP, pinned so nobody re-learns it the expensive way. The live
    /// Teller returns a NON-ZERO `maxDeposit` for an address it will not let
    /// deposit — ours read 5,723,443 while `deposit` reverted. Anyone using
    /// `maxDeposit > 0` as an eligibility check ships a sleeve that fails on
    /// first use.
    function test_maxDeposit_is_not_an_eligibility_check() public {
        assertFalse(teller.permissioned(), "not allowlisted");
        assertGt(teller.maxDeposit(address(sleeve)), 0, "and yet maxDeposit is positive");

        _fundTreasury(100e6);
        vm.prank(treasury);
        vm.expectRevert(SimUsycTeller.NotPermissioned.selector);
        sleeve.depositIdle(100e6);
    }

    // --- once the allowlist lands -------------------------------------------

    function test_a_deposit_buys_shares_at_the_teller_s_own_price() public {
        _park(100e6);
        // nav is 1.142776, so 100 USDC buys about 87.5 USYC. The exact figure is
        // 100e6 * 1e18 / 1_142_775_997_364_038_969 = 87,506,213.
        //
        // THIS NUMBER WAS WRONG AND THE TOLERANCE HID IT. It read 87_506_222
        // against a slack of 10 — passing with nine of those ten units spent,
        // and it would have passed with `previewDeposit` off by up to 10 in
        // either direction. A tolerance that swallows the error it is meant to
        // catch is not a check, so the figure is now exact and the slack is one
        // unit, which is the most a 6-decimal floor can cost.
        uint256 shares = usyc.balanceOf(address(sleeve));
        assertApproxEqAbs(shares, 87_506_213, 1, "shares priced by the Teller");
        assertEq(usdc.balanceOf(address(sleeve)), 0, "no USDC left behind");
    }

    /// The same hygiene `Erc4626Sleeve` keeps, and nothing asserted it there.
    function test_the_allowance_to_the_teller_is_cleared_after_a_deposit() public {
        _park(100e6);
        assertEq(
            usdc.allowance(address(sleeve), address(teller)),
            0,
            "a standing allowance is a permission nobody granted on purpose"
        );
    }

    function test_value_reads_back_what_was_parked_within_rounding() public {
        _park(100e6);
        assertApproxEqAbs(sleeve.valueUsdc(), 100e6, 10, "a round trip loses only dust");
    }

    /// `valueUsdc` is what the treasury can SPEND, so the Teller's exit fee is
    /// already subtracted. Pricing the position at NAV would report money the
    /// fund will certainly keep.
    ///
    /// THE ASSERTION USED TO RE-IMPLEMENT THE STAND-IN'S OWN ARITHMETIC —
    /// `gross - (gross * 50 / 10_000)` is a copy of `SimUsycTeller.previewRedeem`
    /// written out in the test body, so it compared the double against itself
    /// and agreed to 0 rather than to its stated tolerance of 2. That measures
    /// the fixture, not the sleeve. What the SLEEVE is responsible for is
    /// forwarding the Teller's net number instead of pricing at NAV, so that is
    /// what is asserted: equality with `previewRedeem` of its own balance, and
    /// strict inequality against the gross NAV valuation.
    function test_value_is_net_of_the_redemption_fee_not_gross() public {
        _park(100e6);
        uint256 gross = sleeve.valueUsdc();

        teller.setRedemptionFeeBps(50); // 0.5% on the way out
        uint256 net = sleeve.valueUsdc();
        uint256 shares = usyc.balanceOf(address(sleeve));

        assertLt(net, gross, "the fee is inside the number");
        assertEq(net, teller.previewRedeem(shares), "the sleeve forwards the Teller's own net figure");
        // And it is NOT the NAV-gross valuation, which is the mistake this
        // guards: balance x nav would hand the treasury money the fund keeps.
        assertLt(net, shares * teller.nav() / 1e18, "not priced at NAV");
    }

    /// Sized by preview, not by dividing through a NAV: the treasury must end
    /// up with AT LEAST what it asked for, or a correct payment fails.
    function test_a_withdrawal_delivers_at_least_what_was_asked() public {
        _park(100e6);
        uint256 before = usdc.balanceOf(treasury);

        vm.prank(treasury);
        sleeve.withdrawExact(30e6);

        uint256 delivered = usdc.balanceOf(treasury) - before;
        assertGe(delivered, 30e6, "never short, because short refuses a good payment");
        assertLe(delivered, 30e6 + 10, "and not wastefully over");
        assertGt(usyc.balanceOf(address(sleeve)), 0, "the rest stays invested");
    }

    /// The rounding has to survive a price that does not divide evenly, which
    /// is the case the sketch's `amount / nav` arithmetic would have got wrong.
    function test_a_withdrawal_at_an_awkward_price_is_still_not_short() public {
        teller.setNav(1_333_333_333_333_333_333);
        _park(100e6);
        uint256 before = usdc.balanceOf(treasury);

        vm.prank(treasury);
        sleeve.withdrawExact(7_777_777);

        assertGe(usdc.balanceOf(treasury) - before, 7_777_777, "not short at an awkward NAV");
    }

    /// THE ONE REGIME WHERE THE HEADROOM SHARE DOES ANY WORK — and until now
    /// nothing in the repository tested it.
    ///
    /// `withdrawExact` sizes a redemption by ceiling division and then adds one
    /// share of headroom. The ceiling ALONE is provably sufficient while the
    /// redemption fee is zero: `previewRedeem` is then a single floor, and
    /// `ceil(S*A/W)` scaled back through the same NAV cannot land under `A`. A
    /// SECOND floor — the fee subtraction — breaks that proof, and the extra
    /// share is what repairs it.
    ///
    /// Every other withdrawal in this repo runs at fee ZERO.
    /// `setRedemptionFeeBps` is called in exactly two places: the value test
    /// above never withdraws, and `SleeveBenchmark.t.sol` does a FULL exit,
    /// where `toRedeem == shares` and the `if (toRedeem < shares)` guard skips
    /// the increment by construction. So DELETING THE HEADROOM LINE BROKE NO
    /// TEST — the same defect as a reentrancy guard whose test is satisfied by
    /// a different check, and the reason this one exists.
    ///
    /// Fee non-zero AND the withdrawal partial. Either alone makes it vacuous.
    ///
    ///   shares             87,506,213   (100 USDC parked at nav 1.142776)
    ///   previewRedeem(S)   99,500,000   net of 50 bps
    ///   ask                 3,509,167
    ///   ceil(S*A/W)         3,086,170 -> previewRedeem 3,509,166  SHORT by 1
    ///   + 1 share           3,086,171 -> previewRedeem 3,509,168  covers it
    ///
    /// Confirmed able to fail: with the headroom line removed, delivery is
    /// 3,509,166 against a 3,509,167 request and this goes red.
    function test_a_partial_withdrawal_under_a_fee_is_still_not_short() public {
        _park(100e6);
        teller.setRedemptionFeeBps(50); // 0.5% on the way out

        uint256 ask = 3_509_167;
        uint256 before = usdc.balanceOf(treasury);

        vm.prank(treasury);
        sleeve.withdrawExact(ask);

        uint256 delivered = usdc.balanceOf(treasury) - before;
        assertGe(delivered, ask, "short by a unit is a correct payment refused upstairs");
        // The waste stays bounded: the ceiling adds under one share and the
        // headroom exactly one, so at most two shares - about 2.3 micro-USDC
        // at this NAV. Nothing observed this before either.
        assertLe(delivered, ask + 4, "and it does not redeem wastefully more");
    }

    function test_asking_for_more_than_the_position_is_refused_by_name() public {
        _park(10e6);
        vm.prank(treasury);
        vm.expectRevert(bytes("sleeve cannot cover this"));
        sleeve.withdrawExact(50e6);
    }

    function test_only_the_treasury_can_move_the_sleeve() public {
        _park(100e6);
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("not treasury"));
        sleeve.withdrawExact(1e6);

        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("not treasury"));
        sleeve.depositIdle(1e6);
    }

    // --- in situ, as the vault's reserve ------------------------------------

    /// The sleeve is only useful if the VAULT can drive it. This wires it where
    /// the design puts it — the reserve, reached when the working sleeve cannot
    /// cover a payment — and makes a real payment through it.
    function test_the_vault_can_pay_a_bill_out_of_the_usyc_reserve() public {
        MockUSDC vusdc = new MockUSDC();
        SimUsyc vusyc = new SimUsyc();
        SimUsycTeller vteller = new SimUsycTeller(IERC20(address(vusdc)), vusyc);
        vusdc.mint(address(vteller), 1_000e6);

        FloatPrintStore store = new FloatPrintStore();
        address keeper = address(0xE2);
        store.setSigner(keeper, true);
        FloatVault vault = new FloatVault(address(vusdc), address(store), 2e6);

        UsycSleeve reserve =
            new UsycSleeve(address(vteller), address(vusdc), address(vusyc), address(vault));
        RecordingSleeve working = new RecordingSleeve(vusdc, address(vault));

        address executor = address(0xE1);
        address seller = address(0x5E11E7);
        bytes32 SCOUT = keccak256("scout");
        bytes32 INDEX = keccak256("ACR-INF:model-a");

        vault.wire(executor, keeper, address(0xE3), address(0xE4), address(0xE5), working, reserve);
        vault.setPolicy(
            FloatVault.Policy({
                maxPremiumBps: 100,
                humanMaxPremiumBps: 2000,
                maxPrintAge: 1800,
                upperBandBps: 1500,
                lowerBandBps: 1000,
                workingShareBps: 3000,
                bufferHours: 48,
                minTicketUsdc: 25e6
            }),
            keccak256("cfg"), 0, 0, bytes32(0), bytes32(0)
        );
        vault.setAgent(SCOUT, 500e6, 100e6, false, keccak256("cfg"), 0, 0, bytes32(0), bytes32(0));
        vault.allowSeller(SCOUT, seller, true, 0, 0, bytes32(0), bytes32(0));
        vm.prank(keeper);
        store.setPrint(INDEX, 2e15, 500);

        // Fund the reserve through the sleeve, with the allowlist granted.
        vteller.setPermissioned(true);
        vusdc.mint(address(vault), 50e6);
        vm.prank(address(vault));
        vusdc.approve(address(reserve), 40e6);
        vm.prank(address(vault));
        reserve.depositIdle(40e6);

        // Buffer short, working empty: only the USYC reserve can cover this.
        assertEq(vusdc.balanceOf(address(vault)), 10e6, "buffer");
        assertEq(working.valueUsdc(), 0, "working holds nothing");

        (, uint64 pid,,) = store.latest(INDEX);
        FloatVault.SpendReq memory r = FloatVault.SpendReq({
            agentId: SCOUT,
            seller: seller,
            index: INDEX,
            units: 6_000,
            quoteTotal: 12e6,
            printId: pid,
            nonce: "n1"
        });
        vm.prank(executor);
        (bool ok,) = vault.requestSpend(r);

        assertTrue(ok, "the bill was paid out of the treasury fund");
        assertEq(vusdc.balanceOf(seller), 12e6, "the seller got the whole quote");
        assertGt(vusyc.balanceOf(address(reserve)), 0, "and the rest is still invested");
    }
}
