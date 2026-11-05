// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FloatVault} from "../src/float/FloatVault.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";
import {Erc4626Sleeve, NullSleeve} from "../src/float/Sleeves.sol";
import {ISleeve} from "../src/float/IFloat.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MockVault4626, RecordingSleeve, ShortSleeve, ReentrantSleeve} from "./float/Doubles.sol";

/// @notice The automatic path: pricing, refusing, and funding just in time.
contract FloatVaultTest is Test {
    MockUSDC usdc;
    FloatPrintStore store;
    FloatVault vault;
    RecordingSleeve sleeve;

    address executor = address(0xE1);
    address keeper = address(0xE2);
    address approver = address(0xE3);
    address registrar = address(0xE4);
    address studio = address(0xE5);
    address seller = address(0x5E11E7);
    /// The hero agent's own wallet. It must hold nothing, always.
    address scoutWallet = address(0x5C0117);

    bytes32 constant SCOUT = keccak256("scout");
    bytes32 constant WASTER = keccak256("waster");
    bytes32 constant INDEX = keccak256("ACR-INF:model-a");

    /// 0.002 USD per bundle of 1k tokens, at 1e18.
    uint256 constant PRICE_WAD = 2e15;
    /// 6,000 bundles at that price is 12 USDC exactly — the arithmetic every
    /// test below leans on, written out so a reader can check it by hand:
    ///   2e15 * 6000 / 1e12 = 12e18 / 1e12 = 12e6 = 12.000000 USDC
    uint256 constant UNITS = 6_000;
    uint256 constant FAIR = 12e6;

    function setUp() public {
        usdc = new MockUSDC();
        store = new FloatPrintStore();
        store.setSigner(keeper, true);

        vault = new FloatVault(address(usdc), address(store), 2e6);
        sleeve = new RecordingSleeve(usdc, address(vault));
        sleeve.watch(seller);

        vault.wire(executor, keeper, approver, registrar, studio, sleeve, ISleeve(address(0)));
        _setPolicy(100, 2000); // agent band 1%, human band 20%
        _setAgent(SCOUT, 50e6, 20e6, false);
        _setAgent(WASTER, 50e6, 20e6, false);
        _allow(SCOUT, seller);
        _allow(WASTER, seller);

        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 500);

        usdc.mint(address(vault), 100e6);
    }

    // --- helpers -------------------------------------------------------------

    function _setPolicy(uint16 band, uint16 humanBand) internal {
        vault.setPolicy(
            FloatVault.Policy({
                maxPremiumBps: band,
                humanMaxPremiumBps: humanBand,
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
    }

    function _setAgent(bytes32 id, uint256 cap, uint256 perReq, bool frozen) internal {
        vault.setAgent(id, cap, perReq, frozen, keccak256("cfg"), 0, 0, bytes32(0), bytes32(0));
    }

    function _allow(bytes32 id, address who) internal {
        vault.allowSeller(id, who, true, 0, 0, bytes32(0), bytes32(0));
    }

    function _req(bytes32 agentId, uint256 quote, bytes32 nonce)
        internal
        view
        returns (FloatVault.SpendReq memory)
    {
        (, uint64 pid,,) = store.latest(INDEX);
        return FloatVault.SpendReq({
            agentId: agentId,
            seller: seller,
            index: INDEX,
            units: UNITS,
            quoteTotal: quote,
            printId: pid,
            nonce: nonce
        });
    }

    function _spend(FloatVault.SpendReq memory r) internal returns (bool ok, uint256 id) {
        vm.prank(executor);
        return vault.requestSpend(r);
    }

    /// Re-post the current price. Needed after any `vm.warp` past the print age:
    /// a test about the daily cap must not accidentally be refused for staleness
    /// instead, which is a trap worth naming because the first draft of two
    /// tests below fell into it and read as a cap bug.
    function _repost() internal {
        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 500);
    }

    // --- the hero loop -------------------------------------------------------

    function test_a_fair_spend_pays_the_seller_and_writes_a_receipt() public {
        (bool ok, uint256 id) = _spend(_req(SCOUT, FAIR, "n1"));
        assertTrue(ok, "a fair quote should pay");
        assertEq(id, 1);
        assertEq(usdc.balanceOf(seller), FAIR, "seller paid the quote");
        assertEq(vault.receiptCount(), 1);
    }

    /// THE regression test. If `fair` were computed as `priceWad * units` and
    /// compared to a 1e6 quote, it would be 1e12 too large, every band check
    /// would pass, and a 3x overcharge would be paid. This asserts the
    /// denominator directly: a 3x quote must be refused.
    function test_the_fair_band_is_denominated_in_usdc_not_wad() public {
        (string memory reason, uint8 code, uint256 fair,) = vault.classify(_req(SCOUT, FAIR, "n1"));
        assertEq(code, 0, "a fair quote passes");
        assertEq(fair, FAIR, "fair total is USDC at 1e6, not WAD");

        (, uint8 code3,,) = vault.classify(_req(SCOUT, FAIR * 3, "n2"));
        assertEq(code3, vault.D_BAND(), "a 3x quote is over the band");
        reason; // silence
    }

    function test_a_three_times_quote_is_denied_with_the_fair_counter_price() public {
        FloatVault.SpendReq memory r = _req(WASTER, FAIR * 3, "n1");
        vm.expectEmit(true, true, false, true, address(vault));
        emit FloatVault.Denied(
            WASTER, vault.D_BAND(), "quote exceeds ACR fair band", FAIR * 3, FAIR, "n1"
        );
        (bool ok,) = _spend(r);
        assertFalse(ok);
        assertEq(usdc.balanceOf(seller), 0, "nothing moved");
    }

    /// The design choice that makes the judge console possible at all.
    function test_a_refusal_emits_an_event_and_does_not_revert() public {
        // No expectRevert: the call must SUCCEED and report false.
        (bool ok, uint256 id) = _spend(_req(WASTER, FAIR * 3, "n1"));
        assertFalse(ok, "refused");
        assertEq(id, 0, "no receipt");
        assertEq(vault.receiptCount(), 0);
    }

    function test_a_refused_request_cannot_be_retried_on_the_same_nonce() public {
        _spend(_req(WASTER, FAIR * 3, "n1"));
        (, uint8 code,,) = vault.classify(_req(WASTER, FAIR, "n1"));
        assertEq(code, vault.D_REPLAY(), "the nonce is burned by the refusal");
    }

    function test_a_paid_nonce_cannot_be_replayed() public {
        _spend(_req(SCOUT, FAIR, "n1"));
        (bool ok,) = _spend(_req(SCOUT, FAIR, "n1"));
        assertFalse(ok);
        assertEq(usdc.balanceOf(seller), FAIR, "paid once, not twice");
    }

    // --- the agent holds nothing ---------------------------------------------

    /// T6. The claim the whole product rests on.
    function test_the_agents_own_wallet_holds_nothing_before_and_after() public {
        assertEq(usdc.balanceOf(scoutWallet), 0, "before");
        _spend(_req(SCOUT, FAIR, "n1"));
        assertEq(usdc.balanceOf(scoutWallet), 0, "after");
        assertEq(usdc.balanceOf(seller), FAIR, "the seller was paid, not the agent");
    }

    // --- just in time --------------------------------------------------------

    function test_jit_pulls_the_exact_shortfall_and_pays_in_the_same_call() public {
        // Park almost everything, leaving the buffer short of one payment.
        vm.prank(address(vault));
        usdc.transfer(address(sleeve), 95e6);
        assertEq(usdc.balanceOf(address(vault)), 5e6);

        (bool ok,) = _spend(_req(SCOUT, FAIR, "n1"));
        assertTrue(ok);
        assertEq(sleeve.withdrawCalls(), 1, "the sleeve was pulled once");
        assertEq(sleeve.lastRequested(), FAIR - 5e6, "the EXACT shortfall, not the whole quote");
        assertEq(
            sleeve.watchedBalanceAtWithdraw(),
            0,
            "the withdrawal happened BEFORE the seller was paid"
        );
        assertEq(usdc.balanceOf(seller), FAIR);
    }

    function test_a_full_buffer_does_not_touch_the_sleeve() public {
        _spend(_req(SCOUT, FAIR, "n1"));
        assertEq(sleeve.withdrawCalls(), 0, "no yield was disturbed");
    }

    function test_a_sleeve_that_delivers_short_is_caught_by_name() public {
        ShortSleeve short_ = new ShortSleeve(usdc, address(vault));
        vault.setSleeves(short_, ISleeve(address(0)));
        vm.prank(address(vault));
        usdc.transfer(address(short_), 95e6);

        // Build the request BEFORE the cheatcodes. `_req` reads the print store,
        // and that external staticcall would otherwise absorb both the prank and
        // the expectRevert.
        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        vm.prank(executor);
        vm.expectRevert(bytes("sleeve delivered short"));
        vault.requestSpend(r);
    }

    /// The yield venue is the only external call in the spend path, so it is the
    /// one place a re-entrant cap bypass could live. Two things stop it and this
    /// asserts the outer one: the sleeve is not the executor. (The inner one is
    /// that `spent` is bumped before the sleeve is called at all, so even an
    /// executor-privileged re-entry would measure the first payment.)
    function test_a_hostile_sleeve_cannot_spend_from_inside_the_payment_path() public {
        ReentrantSleeve bad = new ReentrantSleeve(usdc, address(vault));
        vault.setSleeves(bad, ISleeve(address(0)));
        vm.prank(address(vault));
        usdc.transfer(address(bad), 95e6);

        bad.arm(
            abi.encodeCall(FloatVault.requestSpend, (_req(SCOUT, FAIR, "reenter")))
        );
        (bool ok,) = _spend(_req(SCOUT, FAIR, "n1"));
        assertTrue(ok, "the honest spend still lands");
        assertTrue(bad.tried(), "the sleeve did try");
        assertFalse(bad.succeeded(), "and the re-entrant call was refused");
        assertEq(usdc.balanceOf(seller), FAIR, "paid once");
    }

    // --- the caps ------------------------------------------------------------

    function test_a_payment_that_would_cross_the_cap_pays_zero_not_the_headroom() public {
        _setAgent(SCOUT, 15e6, 14e6, false); // cap 15, one 12 fits, two do not
        _spend(_req(SCOUT, FAIR, "n1"));
        (bool ok,) = _spend(_req(SCOUT, FAIR, "n2"));
        assertFalse(ok, "refused, not clamped to the 3 USDC of headroom");
        assertEq(usdc.balanceOf(seller), FAIR, "only the first payment");
    }

    function test_the_threshold_is_exclusive_at_the_boundary() public {
        // perRequest == the quote: the agent's own authority is STRICTLY below.
        _setAgent(SCOUT, 50e6, FAIR, false);
        (, uint8 code,,) = vault.classify(_req(SCOUT, FAIR, "n1"));
        assertEq(code, vault.D_PER_REQUEST(), "at the threshold it escalates");

        _setAgent(SCOUT, 50e6, FAIR + 1, false);
        (, uint8 ok,,) = vault.classify(_req(SCOUT, FAIR, "n2"));
        assertEq(ok, 0, "one unit above the threshold it passes");
    }

    function test_the_day_rolls_and_the_daily_cap_refills() public {
        _setAgent(SCOUT, 15e6, 14e6, false);
        _spend(_req(SCOUT, FAIR, "n1"));
        (, uint8 code,,) = vault.classify(_req(SCOUT, FAIR, "n2"));
        assertEq(code, vault.D_DAILY_CAP());

        vm.warp(block.timestamp + 1 days);
        _repost();
        (, uint8 after_,,) = vault.classify(_req(SCOUT, FAIR, "n2"));
        assertEq(after_, 0, "a new day, a fresh cap");
    }

    function test_the_roll_advances_by_whole_periods_and_does_not_drift() public {
        uint64 start;
        (,,,, start,,) = vault.agentOf(SCOUT);
        vm.warp(block.timestamp + 10 days + 6 hours);
        uint64 rolled;
        (,,,, rolled,,) = vault.agentOf(SCOUT);
        assertEq(
            uint256(rolled),
            uint256(start) + 10 days,
            "the window advances in whole days, it does not jump to now"
        );
    }

    /// The bug a single global day-start would have shipped: one agent spending
    /// after a roll zeroes its own total while every other agent keeps
    /// yesterday's against a window that has already moved.
    function test_one_agents_spend_does_not_reset_another_agents_window() public {
        _setAgent(SCOUT, 15e6, 14e6, false);
        _setAgent(WASTER, 15e6, 14e6, false);
        _spend(_req(SCOUT, FAIR, "s1"));
        _spend(_req(WASTER, FAIR, "w1"));

        vm.warp(block.timestamp + 1 days);
        _repost();
        _spend(_req(SCOUT, FAIR, "s2")); // scout rolls first

        (,, uint256 wasterSpent,,,,) = vault.agentOf(WASTER);
        assertEq(wasterSpent, 0, "waster's own window rolled too");
        (, uint8 code,,) = vault.classify(_req(WASTER, FAIR, "w2"));
        assertEq(code, 0, "and waster can still spend its fresh cap");
    }

    // --- the print -----------------------------------------------------------

    function test_a_stale_print_is_refused() public {
        vm.warp(block.timestamp + 1801);
        (, uint8 code,,) = vault.classify(_req(SCOUT, FAIR, "n1"));
        assertEq(code, vault.D_STALE());
    }

    function test_a_rotated_print_is_refused_separately_from_a_stale_one() public {
        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 500); // same price, new id
        (, uint8 code,,) = vault.classify(r);
        assertEq(code, vault.D_ROTATED(), "re-quote, which is a different fix to a stale print");
    }

    function test_an_index_with_no_print_is_refused() public {
        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        r.index = keccak256("never-printed");
        (, uint8 code,,) = vault.classify(r);
        assertEq(code, vault.D_NO_PRINT());
    }

    // --- authority -----------------------------------------------------------

    function test_a_frozen_agent_is_refused_while_another_passes() public {
        _setAgent(WASTER, 50e6, 20e6, true);
        (, uint8 frozen,,) = vault.classify(_req(WASTER, FAIR, "n1"));
        assertEq(frozen, vault.D_FROZEN());
        (, uint8 ok,,) = vault.classify(_req(SCOUT, FAIR, "n2"));
        assertEq(ok, 0, "the identical request passes for an unfrozen agent");
    }

    function test_an_unknown_seller_is_refused() public {
        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        r.seller = address(0xBEEF);
        (, uint8 code,,) = vault.classify(r);
        assertEq(code, vault.D_SELLER());
    }

    function test_a_paused_treasury_refuses_everything() public {
        vault.setPaused(true);
        (, uint8 code,,) = vault.classify(_req(SCOUT, FAIR, "n1"));
        assertEq(code, vault.D_PAUSED());
    }

    function test_only_the_executor_can_request_a_spend() public {
        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        vm.expectRevert(bytes("not executor"));
        vault.requestSpend(r);
    }

    function test_wire_is_one_shot() public {
        vm.expectRevert(bytes("already wired"));
        vault.wire(address(0xDD), keeper, approver, registrar, studio, sleeve, ISleeve(address(0)));
    }

    function test_an_unreachable_per_request_threshold_is_refused_at_configuration() public {
        vm.expectRevert(bytes("per-request above daily cap"));
        _setAgent(SCOUT, 10e6, 20e6, false);
    }

    function test_a_human_band_below_the_agent_band_is_refused() public {
        vm.expectRevert(bytes("human band below agent band"));
        _setPolicy(2000, 100);
    }

    // --- guests --------------------------------------------------------------

    function test_a_guest_gets_the_template_and_cannot_choose_its_own_numbers() public {
        bytes32 guest = keccak256("guest-1");
        vm.prank(registrar);
        vault.registerGuest(guest);
        (bool exists, uint256 cap,, uint256 perReq,,, bool isGuest) = vault.agentOf(guest);
        assertTrue(exists);
        assertTrue(isGuest);
        assertEq(cap, 2e6, "the fixed guest cap");
        assertEq(perReq, 2e6);
    }

    function test_the_registrar_cannot_reach_an_existing_agent() public {
        vm.prank(registrar);
        vm.expectRevert(bytes("agent exists"));
        vault.registerGuest(SCOUT);
    }

    function test_the_registrar_cannot_set_a_policy() public {
        vm.prank(registrar);
        vm.expectRevert(bytes("not owner or studio"));
        _setAgent(keccak256("x"), 1e9, 1e9, false);
    }

    /// A guest with no allowlist at all could pay its own wallet. It gets a
    /// global list instead, so the set of payable sellers is never empty-means-any.
    function test_a_guest_cannot_pay_an_unlisted_seller() public {
        bytes32 guest = keccak256("guest-1");
        vm.prank(registrar);
        vault.registerGuest(guest);

        FloatVault.SpendReq memory r = _req(guest, 1e6, "g1");
        r.units = 500; // 1 USDC fair
        (, uint8 code,,) = vault.classify(r);
        assertEq(code, vault.D_SELLER(), "not payable until the seller is listed globally");

        vault.allowGuestSeller(seller, true);
        (, uint8 ok,,) = vault.classify(r);
        assertEq(ok, 0);
    }

    // --- the real sleeve -----------------------------------------------------

    /// Against a 4626 double that reproduces Morpho V2's always-zero `max*` and
    /// 18-decimal shares. A sleeve that sized itself from `maxWithdraw` reads
    /// zero here and fails.
    function test_the_erc4626_sleeve_reports_value_without_the_max_functions() public {
        MockVault4626 venue = new MockVault4626(usdc);
        Erc4626Sleeve real = new Erc4626Sleeve(address(venue), address(usdc), address(vault));
        vault.setSleeves(real, ISleeve(address(0)));

        assertEq(venue.maxWithdraw(address(real)), 0, "the venue lies about max, by design");

        vm.prank(address(vault));
        usdc.approve(address(real), 40e6);
        vm.prank(address(vault));
        real.depositIdle(40e6);

        assertEq(real.valueUsdc(), 40e6, "value comes from the share balance");
        venue.accrue(4e6); // 10% yield
        assertEq(real.valueUsdc(), 44e6, "and tracks the share price up");
    }

    function test_the_erc4626_sleeve_refuses_a_venue_holding_the_wrong_asset() public {
        MockUSDC other = new MockUSDC();
        MockVault4626 venue = new MockVault4626(other);
        vm.expectRevert(bytes("venue asset mismatch"));
        new Erc4626Sleeve(address(venue), address(usdc), address(vault));
    }

    function test_jit_through_the_real_sleeve_after_yield_has_accrued() public {
        MockVault4626 venue = new MockVault4626(usdc);
        Erc4626Sleeve real = new Erc4626Sleeve(address(venue), address(usdc), address(vault));
        vault.setSleeves(real, ISleeve(address(0)));

        vm.prank(address(vault));
        usdc.approve(address(real), 95e6);
        vm.prank(address(vault));
        real.depositIdle(95e6);
        venue.accrue(5e6);

        (bool ok,) = _spend(_req(SCOUT, FAIR, "n1"));
        assertTrue(ok, "the share price moved and the exact shortfall still came out");
        assertEq(usdc.balanceOf(seller), FAIR);
    }

    function test_a_null_sleeve_refuses_a_deposit_rather_than_swallowing_it() public {
        NullSleeve nul = new NullSleeve();
        vm.expectRevert(bytes("sleeve inactive"));
        nul.depositIdle(1e6);
    }
}
