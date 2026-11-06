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
            WASTER, vault.D_BAND(), INDEX, "quote exceeds ACR fair band", FAIR * 3, FAIR, "n1"
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

    /// The treasury's last payment is the one that lands on this path, because a
    /// share-priced vault reports a parked amount one unit lower than it took.
    /// Saying "sleeve delivered short" there sends the reader to the venue's code
    /// instead of to the balance.
    function test_an_empty_treasury_says_so_rather_than_blaming_the_sleeve() public {
        // Drain the vault to less than one payment, with no sleeve to draw on.
        vm.prank(address(vault));
        usdc.transfer(address(0xDEAD), 100e6 - 1e6);
        vault.setSleeves(ISleeve(address(0)), ISleeve(address(0)));

        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        vm.prank(executor);
        vm.expectRevert(bytes("treasury cannot cover this"));
        vault.requestSpend(r);
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

    /// AND THIS ONE REACHES THE LOCK, which the test above never does.
    ///
    /// `requestSpend` is `external onlyExecutor nonReentrant` (in that order),
    /// so a re-entrant call from a sleeve that is NOT the executor is refused
    /// by `onlyExecutor` and `nonReentrant` is never consulted. The test above
    /// says as much in its own comment, but the consequence is sharper than the
    /// comment admits: DELETING `nonReentrant` FROM `requestSpend` DOES NOT
    /// TURN THAT TEST RED. `docs/SECURITY-AUDIT.md` lists the hand-rolled lock
    /// under "Verified clean", and until this test the claim rested on reading
    /// the code — `grep -n "reentrant"` matched two lines of source and no test
    /// at all.
    ///
    /// So the hostile sleeve is made an executor as well, which is the only way
    /// the re-entrant call gets past the outer check and meets the lock. THAT
    /// IS NOT A THREAT MODEL. It requires the owner to have wired a hostile
    /// contract as an executor, and `setExecutor` is `onlyOwner`. The point is
    /// not that this can happen; it is that the lock the audit claims works can
    /// now be observed working, and observed failing when it is removed.
    ///
    /// THE ASSERTION IS ON THE REVERT REASON, not on the re-entry failing. A
    /// bare `assertFalse(succeeded)` passes whether the answer came from
    /// `onlyExecutor` or from `nonReentrant`, which is exactly how the older
    /// test came to assert the wrong mechanism. `ReentrantSleeve` now keeps the
    /// returndata it used to drop so the two are distinguishable.
    ///
    /// The cap is set so ONE payment fits and two do not, and the re-entry
    /// carries a FRESH NONCE. Both are deliberate: with the lock removed, the
    /// re-entrant call must get far enough to be judged on the cap, or the
    /// negative control proves nothing about which defence holds.
    function test_the_reentrancy_lock_itself_refuses_an_executor_privileged_reentry() public {
        ReentrantSleeve bad = new ReentrantSleeve(usdc, address(vault));
        vault.setSleeves(bad, ISleeve(address(0)));
        // The line that makes the inner defence reachable at all.
        vault.setExecutor(address(bad), true);
        // One payment fits, two do not: cap $20 against a $12 quote.
        _setAgent(SCOUT, 20e6, 20e6, false);

        // Strand most of the float in the sleeve so the payment has to pull,
        // because `_fund` returns early when the buffer already covers the
        // quote and then the sleeve is never called.
        vm.prank(address(vault));
        usdc.transfer(address(bad), 95e6);

        bad.arm(abi.encodeCall(FloatVault.requestSpend, (_req(SCOUT, FAIR, "reenter"))));
        (bool ok,) = _spend(_req(SCOUT, FAIR, "n1"));

        assertTrue(ok, "the honest spend still lands");
        assertTrue(bad.tried(), "the sleeve did try to re-enter");
        assertFalse(bad.succeeded(), "and the re-entrant call was refused");
        assertEq(
            bad.lastErrorMessage(),
            "reentrant",
            "the LOCK refused it - any other string means a different defence answered first"
        );
        assertEq(usdc.balanceOf(seller), FAIR, "paid once, not twice");
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

    /// A registrar could pre-claim an id the owner meant for a real agent, and
    /// `setAgent` never cleared the guest flag — so that agent stayed on the
    /// GLOBAL guest seller allowlist forever, able to pay anyone listed there.
    function test_configuring_an_agent_takes_it_off_the_guest_allowlist() public {
        bytes32 id = keccak256("was-a-guest");
        vm.prank(registrar);
        vault.registerGuest(id);
        (,,,,,, bool guestBefore) = vault.agentOf(id);
        assertTrue(guestBefore);

        _setAgent(id, 50e6, 20e6, false);
        (,,,,,, bool guestAfter) = vault.agentOf(id);
        assertFalse(guestAfter, "the owner's configuration wins over a pre-claim");
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

        // NO ALLOWANCE ASSERTION HERE, AND THE REASON IS WORTH THE LINES.
        //
        // `assertEq(usdc.allowance(address(real), address(venue)), 0)` looks
        // like the obvious way to cover the reset at `Sleeves.sol:69`, and it
        // is VACUOUS against this double. `MockVault4626.deposit` pulls the
        // full `assets` through `transferFrom`, which consumes the entire
        // allowance on its own, so the assertion holds whether or not the
        // sleeve clears anything. Proven rather than assumed: with the
        // `approve(venue, 0)` line deleted from `Sleeves.sol`, this test still
        // passed.
        //
        // The reset only does work when the venue pulls LESS than it was
        // approved for — which is exactly the case its own comment cites — so
        // that is where the assertion belongs. See
        // `test_an_under_pulling_venue_leaves_no_standing_allowance` in
        // FloatVenueFailure.t.sol.
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

    /// `setSleeves` CAN ORPHAN MONEY, and nothing in the contract stops it.
    ///
    /// The setter is four lines with no guard beyond `onlyOwner` — no
    /// `valueUsdc() == 0` check, no drain, no pause requirement
    /// (`FloatVault.sol:356-360`). `_underManagement()` (`:613-618`) sums only
    /// the CURRENTLY WIRED sleeves, so re-pointing `working` away from a funded
    /// one drops that balance out of `totalValueUsdc()` and out of the
    /// `"treasury cannot cover this"` guard at `:821`. `FloatVenueFailure.t.sol`
    /// names the hazard in prose and tests nothing, and `totalValueUsdc()` was
    /// asserted by no test at all.
    ///
    /// THIS PINS THE CURRENT BEHAVIOUR; IT IS NOT A FIX. The vault is deployed
    /// and Blockscout-verified at an address cited in three submission docs, the
    /// runbook and three live pages, and it carries the on-chain receipt
    /// history — so a guard means a redeploy that invalidates all of it, and
    /// adding the guard to source WITHOUT redeploying would be worse still: the
    /// verified source would stop describing the bytecode that is running. The
    /// mitigation is operational and is now in the runbook — drain a sleeve
    /// before re-pointing it. When a future deploy does add the guard, this is
    /// the test that will go red and say so.
    function test_setSleeves_orphans_a_funded_sleeve_and_the_treasury_stops_counting_it()
        public
    {
        MockVault4626 venue = new MockVault4626(usdc);
        Erc4626Sleeve real = new Erc4626Sleeve(address(venue), address(usdc), address(vault));
        vault.setSleeves(real, ISleeve(address(0)));

        vm.prank(address(vault));
        usdc.approve(address(real), 95e6);
        vm.prank(address(vault));
        real.depositIdle(95e6);

        assertEq(vault.totalValueUsdc(), 100e6, "buffer plus sleeve, all of it reachable");

        // Re-point `working` away from the funded sleeve. Nothing refuses this,
        // nothing warns, and the only trace is a `SleevesSet` event.
        vault.setSleeves(ISleeve(address(0)), ISleeve(address(0)));

        assertEq(real.valueUsdc(), 95e6, "the money still exists, untouched");
        assertEq(vault.totalValueUsdc(), 5e6, "and the treasury has stopped counting it");

        // THE CONSEQUENCE, not just the accounting. A payment that the 95 USDC
        // in the orphaned sleeve would cover is refused — and refused by a
        // message that blames the treasury rather than naming the sleeve the
        // money is stranded in.
        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        vm.prank(executor);
        vm.expectRevert(bytes("treasury cannot cover this"));
        vault.requestSpend(r);
    }

    /// THE TREASURY'S LAST UNIT IS UNSPENDABLE, and the refusal blames the
    /// treasury rather than the arithmetic that caused it.
    ///
    /// `FloatVault.sol:810-819` describes this precisely and no test entered
    /// it: *"Parking an amount in a share-priced vault makes its reported value
    /// read one unit lower (the deposit floors, then the conversion back floors
    /// again), so buffer-plus-sleeve is slightly less than what was funded and
    /// the treasury's LAST payment lands here."*
    ///
    /// TWO TESTS NEARBY LOOK LIKE THEY COVER IT AND DO NOT.
    /// `test_an_empty_treasury_says_so_rather_than_blaming_the_sleeve` carries
    /// that very docstring but sets both sleeves to zero, so there is no share
    /// pricing and no rounding — it is the plain empty-treasury case.
    /// `test_jit_through_the_real_sleeve_after_yield_has_accrued` picks 95e6 +
    /// 5e6 against 95e18 shares, which divides exactly; `SleeveBenchmark.t.sol`
    /// already records that flaw about it.
    ///
    /// THE RATIO HAS TO BE MADE AWKWARD ON PURPOSE, and this is the part that
    /// makes the test real rather than decorative. A SOLE depositor can never
    /// lose a unit: its shares are the entire supply, so `convertToAssets`
    /// returns `totalAssets` exactly and the floor is a no-op. The loss needs
    /// the sleeve to hold a FRACTION of the supply — hence another depositor
    /// first, and a single unit of yield accruing before the sleeve parks.
    function test_the_last_unit_parked_in_a_share_priced_sleeve_cannot_be_spent() public {
        MockVault4626 venue = new MockVault4626(usdc);
        Erc4626Sleeve real = new Erc4626Sleeve(address(venue), address(usdc), address(vault));
        vault.setSleeves(real, ISleeve(address(0)));

        // Somebody else is already in the venue and ONE unit of yield has
        // accrued, so the share price stops dividing evenly.
        usdc.mint(address(this), 1e6);
        usdc.approve(address(venue), 1e6);
        venue.deposit(1e6, address(this));
        venue.accrue(1);

        // Leave a 2 USDC buffer and park 10, so the treasury genuinely holds 12.
        vm.prank(address(vault));
        usdc.transfer(address(0xDEAD), 88e6);
        vm.prank(address(vault));
        usdc.approve(address(real), 10e6);
        vm.prank(address(vault));
        real.depositIdle(10e6);

        assertEq(usdc.balanceOf(address(vault)), 2e6, "a 2 USDC buffer");
        assertEq(real.valueUsdc(), 9_999_999, "and the sleeve reports a unit LESS than was parked");
        assertEq(vault.totalValueUsdc(), 11_999_999, "so the treasury believes it holds 11.999999");

        // The money is all there — 2 in the buffer, 10 in the venue — and the
        // last unit of it cannot be spent.
        FloatVault.SpendReq memory full = _req(SCOUT, 12e6, "n1");
        vm.prank(executor);
        vm.expectRevert(bytes("treasury cannot cover this"));
        vault.requestSpend(full);

        // One unit less clears. That is what makes this a one-unit boundary
        // rather than some larger hole: the vault is wrong by exactly the
        // rounding, and no more.
        (bool ok,) = _spend(_req(SCOUT, 11_999_999, "n2"));
        assertTrue(ok, "a unit under the reported total pays");
        assertEq(usdc.balanceOf(seller), 11_999_999, "the seller was paid the reported total");
    }

    // --- the submitting keys -------------------------------------------------

    /// The key that PARKS a spend must not be the key that APPROVES it, or one
    /// compromised hot key opens its own checkpoint and signs it.
    function test_an_executor_cannot_also_be_the_human_approver() public {
        vm.expectRevert(bytes("approver is an executor"));
        vault.setApprover(executor);

        vm.expectRevert(bytes("approver is an executor"));
        vault.setExecutor(approver, true);
    }

    /// Two processes submit — an automatic spend loop and a human-gate service —
    /// and they hold separate keys, so one can be revoked without stopping the
    /// other. Same reason `PolicyWallet.isAgent` is a mapping.
    function test_a_second_executor_can_be_authorized_and_revoked() public {
        address other = address(0xE9);
        vault.setExecutor(other, true);

        FloatVault.SpendReq memory r = _req(SCOUT, FAIR, "n1");
        vm.prank(other);
        (bool ok,) = vault.requestSpend(r);
        assertTrue(ok, "a second operator submits on its own key");

        vault.setExecutor(other, false);
        FloatVault.SpendReq memory r2 = _req(SCOUT, FAIR, "n2");
        vm.prank(other);
        vm.expectRevert(bytes("not executor"));
        vault.requestSpend(r2);
        assertTrue(true);
    }
}
