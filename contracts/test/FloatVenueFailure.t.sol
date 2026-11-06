// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FloatVault} from "../src/float/FloatVault.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";
import {Erc4626Sleeve} from "../src/float/Sleeves.sol";
import {ISleeve} from "../src/float/IFloat.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MockVault4626, RecordingSleeve, RevertingSleeve, GatedVault4626} from "./float/Doubles.sol";

/// @notice What happens when the yield venue — which is somebody else's
///         contract — misbehaves.
///
/// Float's treasury parks idle float in a Morpho Vault V2 nobody here controls.
/// `FloatVault` is careful about this in the paths it covers: it MEASURES its
/// own balance after a pull instead of trusting the sleeve, and it names the
/// two failures differently. But three paths had no test at all, and this file
/// pins them.
///
/// These tests assert what the contract DOES today, including where that is
/// uncomfortable. `contracts/src/float` is verified on Blockscout, so this is a
/// record and a regression net, not a redesign.
contract FloatVenueFailureTest is Test {
    MockUSDC usdc;
    FloatPrintStore store;
    FloatVault vault;

    address executor = address(0xE1);
    address keeper = address(0xE2);
    address approver = address(0xE3);
    address registrar = address(0xE4);
    address studio = address(0xE5);
    address seller = address(0x5E11E7);

    bytes32 constant SCOUT = keccak256("scout");
    bytes32 constant INDEX = keccak256("ACR-INF:model-a");
    uint256 constant PRICE_WAD = 2e15;
    uint256 constant UNITS = 6_000;
    uint256 constant FAIR = 12e6; // 2e15 * 6000 / 1e12

    function setUp() public {
        usdc = new MockUSDC();
        store = new FloatPrintStore();
        store.setSigner(keeper, true);
        vault = new FloatVault(address(usdc), address(store), 2e6);
        vm.prank(keeper);
        store.setPrint(INDEX, PRICE_WAD, 500);
    }

    // --- helpers, mirroring FloatVault.t.sol so the numbers read the same ----

    function _policy() internal {
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
    }

    function _agent() internal {
        vault.setAgent(SCOUT, 500e6, 100e6, false, keccak256("cfg"), 0, 0, bytes32(0), bytes32(0));
        vault.allowSeller(SCOUT, seller, true, 0, 0, bytes32(0), bytes32(0));
    }

    function _req(uint256 quote, bytes32 nonce) internal view returns (FloatVault.SpendReq memory) {
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

    // --- 1 · the venue will not pay out -------------------------------------

    /// THE MODE WITH NO COVERAGE UNTIL NOW, and the one most likely to be
    /// mistaken for our bug.
    ///
    /// `requestSpend` is built so a refusal RETURNS FALSE and emits `Denied`:
    /// the transaction succeeds and the reason is on chain in English. That is
    /// the refusal ladder's whole promise. A venue that will not pay out keeps
    /// none of it — there is no try/catch anywhere in `src/float`, so the
    /// revert propagates, nothing is emitted, and on real Morpho V2 the caller
    /// sees a bare custom-error selector with nothing naming the venue.
    ///
    /// Pinning it here means a future change that quietly swallows the revert
    /// has to argue with this test first.
    function test_a_venue_that_will_not_pay_out_reverts_and_emits_no_refusal() public {
        RevertingSleeve stuck = new RevertingSleeve(usdc, 50e6);
        vault.wire(executor, keeper, approver, registrar, studio, stuck, ISleeve(address(0)));
        _policy();
        _agent();

        // Buffer short of the quote, so the payment must reach the sleeve.
        usdc.mint(address(vault), 5e6);
        assertLt(usdc.balanceOf(address(vault)), FAIR, "the buffer must not cover it");

        // And policy is perfectly happy: this is NOT a refusal case.
        (, uint8 code,,) = vault.classify(_req(FAIR, "n1"));
        assertEq(code, 0, "policy allows it: the venue is the only problem");

        // Build the request BEFORE the cheatcodes. `_req` calls `store.latest`,
        // and an external call consumes `prank`/`expectRevert` — which is what
        // the first draft of this test did, reporting "not executor" and "did
        // not revert" for a vault that was behaving correctly.
        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        vm.prank(executor);
        vm.expectRevert(bytes("venue: withdraw gated"));
        vault.requestSpend(r);

        // Nothing moved, and nothing was recorded.
        assertEq(usdc.balanceOf(seller), 0, "the seller was not paid");
        assertEq(vault.receiptCount(), 0, "no receipt");
    }

    /// The same hazard seen from the dry run: `classify` says yes and the real
    /// call reverts. `_check` never consults the sleeve, so the twelve codes
    /// cannot express "the money is not reachable". This is why the clients
    /// carry their own funding pre-check in `float/src/funding.ts`.
    function test_classify_cannot_see_a_venue_that_will_not_pay() public {
        RevertingSleeve stuck = new RevertingSleeve(usdc, 50e6);
        vault.wire(executor, keeper, approver, registrar, studio, stuck, ISleeve(address(0)));
        _policy();
        _agent();
        usdc.mint(address(vault), 5e6);

        (string memory reason, uint8 code,,) = vault.classify(_req(FAIR, "n1"));
        assertEq(code, 0, "the dry run promises a payment");
        assertEq(reason, "", "with no reason to the contrary");
    }

    // --- 2 · the reserve sleeve, which had never executed --------------------

    /// Every other test in the repo wires `reserve` as `address(0)`, so
    /// `_fund`'s second branch — the ONLY unclamped `withdrawExact` in the
    /// codebase — had never run. It is unclamped because the first pull is
    /// sized from the measured balance, which is the right design; this proves
    /// the handoff works.
    function test_the_reserve_pays_what_the_working_sleeve_cannot() public {
        RecordingSleeve working = new RecordingSleeve(usdc, address(vault));
        RecordingSleeve reserve = new RecordingSleeve(usdc, address(vault));
        vault.wire(executor, keeper, approver, registrar, studio, working, reserve);
        _policy();
        _agent();

        usdc.mint(address(vault), 5e6); // buffer
        usdc.mint(address(working), 3e6); // not enough on its own
        usdc.mint(address(reserve), 50e6);

        FloatVault.SpendReq memory r = _req(FAIR, "n1");
        vm.prank(executor);
        (bool ok,) = vault.requestSpend(r);

        assertTrue(ok, "the payment should clear across both sleeves");
        assertEq(usdc.balanceOf(seller), FAIR, "the seller got the whole quote");
        // Working gave everything it had; the reserve covered the remainder,
        // sized from the MEASURED balance rather than from the original ask.
        assertEq(working.lastRequested(), 3e6, "working was asked for exactly what it held");
        assertEq(reserve.lastRequested(), FAIR - 5e6 - 3e6, "the reserve covered the rest");
        assertEq(usdc.balanceOf(address(working)), 0, "working is empty");
    }

    // --- 3 · rebalance, which no test had ever called ------------------------

    function test_rebalance_parks_the_excess_split_across_both_sleeves() public {
        RecordingSleeve working = new RecordingSleeve(usdc, address(vault));
        RecordingSleeve reserve = new RecordingSleeve(usdc, address(vault));
        vault.wire(executor, keeper, approver, registrar, studio, working, reserve);
        _policy();

        usdc.mint(address(vault), 100e6);
        vm.prank(keeper);
        vault.rebalance(50e6); // hi = 57.5e6, excess = 50e6, over the 25e6 ticket

        // workingShareBps is 3000, so 30/70.
        assertEq(usdc.balanceOf(address(working)), 15e6, "30% to working");
        assertEq(usdc.balanceOf(address(reserve)), 35e6, "70% to reserve");
        assertEq(usdc.balanceOf(address(vault)), 50e6, "the buffer is the target");
    }

    function test_rebalance_pulls_back_when_the_buffer_is_under_the_band() public {
        RecordingSleeve working = new RecordingSleeve(usdc, address(vault));
        vault.wire(executor, keeper, approver, registrar, studio, working, ISleeve(address(0)));
        _policy();

        usdc.mint(address(vault), 10e6);
        usdc.mint(address(working), 90e6);

        vm.prank(keeper);
        vault.rebalance(50e6); // lo = 45e6, need = 40e6, over the ticket

        assertEq(usdc.balanceOf(address(vault)), 50e6, "pulled up to the target");
        assertEq(working.lastRequested(), 40e6, "asked the sleeve for the shortfall");
    }

    /// `minTicketUsdc` is the rule that a rebalance costing more in fees than it
    /// earns is a loss dressed as activity. Both directions, one unit inside it.
    function test_rebalance_below_the_minimum_ticket_moves_nothing() public {
        RecordingSleeve working = new RecordingSleeve(usdc, address(vault));
        vault.wire(executor, keeper, approver, registrar, studio, working, ISleeve(address(0)));
        _policy();

        usdc.mint(address(vault), 100e6);
        vm.prank(keeper);
        vault.rebalance(76e6); // excess 24e6, one under the 25e6 ticket

        assertEq(usdc.balanceOf(address(vault)), 100e6, "nothing parked");
        assertEq(working.depositCalls(), 0, "the sleeve was not touched");
    }

    /// PINS AN ASYMMETRY RATHER THAN ENDORSING IT. `Erc4626Sleeve` is careful to
    /// reset its allowance to the venue after every deposit; `rebalance` grants
    /// the sleeve an allowance over the vault's buffer and never resets it.
    /// Harmless against a sleeve that pulls exactly what it was approved for,
    /// which ours does — but `setSleeves` can re-point `working` without
    /// checks, so the standing allowance outlives the sleeve that earned it.
    function test_rebalance_leaves_a_standing_allowance_on_the_sleeve() public {
        RecordingSleeve working = new RecordingSleeve(usdc, address(vault));
        vault.wire(executor, keeper, approver, registrar, studio, working, ISleeve(address(0)));
        _policy();

        usdc.mint(address(vault), 100e6);
        vm.prank(keeper);
        vault.rebalance(50e6);

        // It pulled exactly what it was approved for, so the remainder is zero
        // by arithmetic rather than by hygiene. Recorded so a sleeve that pulls
        // LESS than approved is a visible change here, not a silent one.
        assertEq(
            usdc.allowance(address(vault), address(working)),
            0,
            "today the sleeve consumes its whole allowance; if that changes, so does this"
        );
    }

    // --- 4 · a venue that takes the money and issues no claim ----------------

    /// `Erc4626Sleeve.depositIdle` discards `deposit`'s return value and never
    /// checks that its position rose, so a venue that banks the USDC and mints
    /// zero shares is reported as a successful park. `valueUsdc` reads the
    /// share balance, so the money becomes invisible to the treasury and
    /// unrecoverable: the sleeve has no sweep.
    ///
    /// This asserts the loss, which is the honest thing to do with a hazard the
    /// verified contract cannot currently detect.
    function test_a_venue_that_mints_no_shares_is_still_reported_as_parked() public {
        GatedVault4626 venue = new GatedVault4626(usdc);
        Erc4626Sleeve sleeve = new Erc4626Sleeve(address(venue), address(usdc), address(this));
        venue.setMintZeroShares(true);

        usdc.mint(address(this), 10e6);
        usdc.approve(address(sleeve), 10e6);
        sleeve.depositIdle(10e6);

        assertEq(usdc.balanceOf(address(venue)), 10e6, "the venue took the money");
        assertEq(
            sleeve.valueUsdc(), 0, "and the sleeve reports nothing, because it holds no shares"
        );
    }

    /// The same double, behaving normally, to prove the hazard above is the
    /// switch and not the fixture. A control for the control.
    function test_the_same_venue_behaving_normally_parks_and_reports() public {
        GatedVault4626 venue = new GatedVault4626(usdc);
        Erc4626Sleeve sleeve = new Erc4626Sleeve(address(venue), address(usdc), address(this));

        usdc.mint(address(this), 10e6);
        usdc.approve(address(sleeve), 10e6);
        sleeve.depositIdle(10e6);

        assertEq(sleeve.valueUsdc(), 10e6, "shares were minted and the value reads back");
    }

    /// A STALE PRINT DOES NOT STOP A REBALANCE — pinned, not endorsed.
    ///
    /// `classify` refuses a PAYMENT whose print is older than
    /// `policy.maxPrintAge` (rung 8, "stale ACR print"). `rebalance` reads no
    /// price at all — not `prices`, not `postedAt`, not `maxPrintAge` — so the
    /// treasury keeps moving float between its buffer and its sleeves on prints
    /// the very same contract would refuse to pay against.
    ///
    /// That is defensible on its own terms: a rebalance moves the treasury's
    /// own money between its own accounts and prices nothing, so a stale index
    /// cannot mis-price it. What a stale index CAN do is size the buffer from
    /// provider disagreement that no longer holds — and that is the keeper's
    /// business, not the vault's. `float/src/margin.ts` now excludes stale
    /// indices from the margin for exactly that reason. This test is the
    /// contract-side half of that statement: the freshness notion lives in the
    /// keeper BECAUSE the vault has none here.
    ///
    /// Before this, the whole file contained ZERO `vm.warp` calls, so every
    /// rebalance test ran against a print posted in the same block and this
    /// asymmetry was invisible.
    function test_a_stale_print_does_not_stop_a_rebalance() public {
        RecordingSleeve working = new RecordingSleeve(usdc, address(vault));
        vault.wire(executor, keeper, approver, registrar, studio, working, ISleeve(address(0)));
        _policy();
        _agent();

        usdc.mint(address(vault), 100e6);

        // Age the print far past the policy's 1800s.
        vm.warp(block.timestamp + 7 days);
        (, uint8 code,,) = vault.classify(_req(FAIR, "n1"));
        assertEq(code, vault.D_STALE(), "a PAYMENT on this print would be refused");

        // And yet the treasury rebalances on it. Excess 50, workingShareBps
        // 3000 -> 15 to working; the 35 bound for a reserve has nowhere to go.
        vm.prank(keeper);
        vault.rebalance(50e6);

        assertEq(usdc.balanceOf(address(vault)), 85e6, "the buffer moved anyway");
        assertEq(usdc.balanceOf(address(working)), 15e6, "and the sleeve was funded");
        assertEq(working.depositCalls(), 1, "on a print the vault would not pay against");
    }

    // --- 4 · a venue that pulls less than it was approved for ----------------

    /// THE ONE CASE `Erc4626Sleeve`'s ALLOWANCE RESET WAS WRITTEN FOR.
    ///
    /// `depositIdle` approves exactly, deposits, then clears
    /// (`Sleeves.sol:69`), and its comment gives the reason: *"A venue that
    /// pulls less than it was approved for leaves a standing allowance against
    /// this sleeve's balance."* Nothing asserted the reset, and the obvious
    /// assertion could not have caught a regression: every deposit double in
    /// the repo — `MockVault4626`, `GatedVault4626`, `SimUsycTeller` and all
    /// four sleeve doubles — pulled the FULL amount, which consumes the whole
    /// allowance by arithmetic. Deleting `approve(venue, 0)` from `Sleeves.sol`
    /// left `FloatVault.t.sol`'s version of this assertion GREEN. Measured, not
    /// assumed.
    ///
    /// `setPullShortfall` is the mode that makes the reset load-bearing, and
    /// with it this test goes red when the reset is removed.
    function test_an_under_pulling_venue_leaves_no_standing_allowance() public {
        GatedVault4626 venue = new GatedVault4626(usdc);
        Erc4626Sleeve sleeve = new Erc4626Sleeve(address(venue), address(usdc), address(this));

        venue.setPullShortfall(1e6); // takes 1 USDC less than it is handed

        usdc.mint(address(this), 40e6);
        usdc.approve(address(sleeve), 40e6);
        sleeve.depositIdle(40e6);

        assertEq(venue.totalAssets(), 39e6, "the venue under-pulled, by design");
        assertEq(
            usdc.balanceOf(address(sleeve)),
            1e6,
            "so a USDC the venue declined is left sitting in the sleeve"
        );
        assertEq(
            usdc.allowance(address(sleeve), address(venue)),
            0,
            "and the leftover APPROVAL over it was cleared - without the reset the venue keeps a live claim"
        );
    }

    // --- 5 · a capped venue takes the whole rebalance tick with it -----------

    /// A REBALANCE TICK IS ALL-OR-NOTHING, and that cuts both ways.
    ///
    /// `rebalance` deposits into working, then into reserve, with no try/catch
    /// anywhere in `src/float` (`FloatVault.sol:973-980`). So one venue
    /// refusing a deposit reverts the entire tick — including the leg that
    /// already succeeded — and the keeper's tick dies with nothing recorded.
    ///
    /// This is the good half and the bad half of the same property. GOOD: no
    /// partial rebalance can happen, so the treasury never ends up in a state
    /// nobody designed. BAD: a cap on ONE venue stops the treasury rebalancing
    /// at all, silently, until someone reads the keeper's logs — and Morpho V2
    /// vaults do have caps.
    ///
    /// The working leg is wired to a healthy venue and the RESERVE is the
    /// capped one, so the assertion is specifically that a SUCCESSFUL deposit
    /// is rolled back. `GatedVault4626.setDepositCap` existed and was called by
    /// no test.
    function test_a_capped_reserve_venue_rolls_back_the_working_deposit_too() public {
        MockVault4626 healthy = new MockVault4626(usdc);
        Erc4626Sleeve working = new Erc4626Sleeve(address(healthy), address(usdc), address(vault));

        GatedVault4626 capped = new GatedVault4626(usdc);
        Erc4626Sleeve reserve = new Erc4626Sleeve(address(capped), address(usdc), address(vault));

        vault.wire(executor, keeper, approver, registrar, studio, working, reserve);
        _policy();

        usdc.mint(address(vault), 100e6);
        // Target 50: excess 50, workingShareBps 3000 -> 15 to working, 35 to
        // reserve. A 10 USDC cap on the reserve refuses its 35.
        capped.setDepositCap(10e6);

        vm.prank(keeper);
        vm.expectRevert(bytes("venue: deposit cap"));
        vault.rebalance(50e6);

        // Nothing moved anywhere — including the working leg, which had already
        // taken its 15 USDC before the reserve refused.
        assertEq(usdc.balanceOf(address(vault)), 100e6, "the buffer is untouched");
        assertEq(healthy.totalAssets(), 0, "and the deposit that SUCCEEDED was rolled back");
        assertEq(working.valueUsdc(), 0, "so the working sleeve holds nothing");
    }

    /// The control: the same wiring with the cap lifted parks both legs. Without
    /// this, the test above would pass just as well if the split arithmetic were
    /// wrong and nothing had ever been deposited.
    function test_the_same_rebalance_parks_both_legs_once_the_cap_is_lifted() public {
        MockVault4626 healthy = new MockVault4626(usdc);
        Erc4626Sleeve working = new Erc4626Sleeve(address(healthy), address(usdc), address(vault));

        GatedVault4626 capped = new GatedVault4626(usdc);
        Erc4626Sleeve reserve = new Erc4626Sleeve(address(capped), address(usdc), address(vault));

        vault.wire(executor, keeper, approver, registrar, studio, working, reserve);
        _policy();

        usdc.mint(address(vault), 100e6);
        // No cap set this time.
        vm.prank(keeper);
        vault.rebalance(50e6);

        assertEq(usdc.balanceOf(address(vault)), 50e6, "parked down to the target");
        assertEq(working.valueUsdc(), 15e6, "30% of the excess to working");
        assertEq(reserve.valueUsdc(), 35e6, "and the rest to the reserve");
    }
}
