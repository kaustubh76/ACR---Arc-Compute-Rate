// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FloatVault} from "../src/float/FloatVault.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";
import {Erc4626Sleeve} from "../src/float/Sleeves.sol";
import {ISleeve} from "../src/float/IFloat.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {RecordingSleeve, RevertingSleeve, GatedVault4626} from "./float/Doubles.sol";

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
}
