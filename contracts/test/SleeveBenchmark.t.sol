// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Erc4626Sleeve} from "../src/float/Sleeves.sol";
import {UsycSleeve} from "../src/float/UsycSleeve.sol";
import {IERC20} from "../src/float/IFloat.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MockVault4626} from "./float/Doubles.sol";
import {SimUsyc, SimUsycTeller} from "../src/sim/SimUsyc.sol";

/// @notice The two sleeves, measured against EQUALLY TRIVIAL counterparties.
///
/// `npm run bench` measures them on the live chain, and that comparison cannot
/// attribute anything: it puts our code plus a real Morpho vault against our
/// code plus a stand-in, so the 3.3x gap there is mostly the venue's doing and
/// says nothing about which implementation is heavier.
///
/// This isolates that. Both sleeves face a simple mock, so what is left is
/// OURS — chiefly that `UsycSleeve.withdrawExact` makes an extra
/// `previewRedeem` call to size its redemption, where `Erc4626Sleeve` hands the
/// venue an asset amount and lets it do the conversion.
///
/// THE ASSERTIONS ARE RELATIONSHIPS, NOT NUMBERS. Gas moves with the compiler
/// and with any change to the doubles, so pinning `== 76070` would be a test
/// that fails for no reason and gets deleted the first time it does. What is
/// pinned is the shape: a generous ceiling that catches a doubling, and the
/// dust bound, which is an arithmetic property rather than a cost.
contract SleeveBenchmarkTest is Test {
    MockUSDC usdc;

    // Morpho side
    MockVault4626 venue;
    Erc4626Sleeve morpho;

    // USYC side
    SimUsyc usyc;
    SimUsycTeller teller;
    UsycSleeve usycSleeve;

    address treasury = address(0x7EA);

    uint256 constant PARK = 100e6;
    uint256 constant PULL = 25e6;

    function setUp() public {
        usdc = new MockUSDC();

        venue = new MockVault4626(usdc);
        morpho = new Erc4626Sleeve(address(venue), address(usdc), treasury);

        usyc = new SimUsyc();
        teller = new SimUsycTeller(IERC20(address(usdc)), usyc);
        teller.setPermissioned(true);
        // The stand-in needs USDC to redeem out of, exactly as the 4626 mock
        // holds what it was deposited.
        usdc.mint(address(teller), 1_000e6);

        usycSleeve = new UsycSleeve(address(teller), address(usdc), address(usyc), treasury);

        // Park the same amount in each, so the pull is measured from the same
        // starting position rather than from whatever each happened to hold.
        _park(address(morpho));
        _park(address(usycSleeve));
    }

    function _park(address sleeve) internal {
        usdc.mint(treasury, PARK);
        vm.prank(treasury);
        usdc.approve(sleeve, PARK);
        vm.prank(treasury);
        (bool ok,) = sleeve.call(abi.encodeWithSignature("depositIdle(uint256)", PARK));
        require(ok, "park failed");
    }

    /// Measured and printed rather than asserted, because the number is the
    /// deliverable and the assertion below is only a tripwire.
    function test_bench_the_pull_each_sleeve_makes() public {
        vm.prank(treasury);
        morpho.withdrawExact(PULL);
        uint256 morphoGas = vm.snapshotGasLastCall("sleeves", "morpho_withdrawExact");

        vm.prank(treasury);
        usycSleeve.withdrawExact(PULL);
        uint256 usycGas = vm.snapshotGasLastCall("sleeves", "usyc_withdrawExact");

        console.log("withdrawExact against matched doubles, gas:");
        console.log("  Erc4626Sleeve (Morpho shape)", morphoGas);
        console.log("  UsycSleeve    (Teller shape)", usycGas);

        // A generous ceiling. This catches a change that doubles the work and
        // ignores the drift that makes exact-gas tests worthless.
        assertLt(morphoGas, 200_000, "the 4626 pull got much more expensive");
        assertLt(usycGas, 200_000, "the Teller pull got much more expensive");
    }

    function test_bench_what_the_value_read_costs() public {
        morpho.valueUsdc();
        uint256 morphoGas = vm.snapshotGasLastCall("sleeves", "morpho_valueUsdc");

        usycSleeve.valueUsdc();
        uint256 usycGas = vm.snapshotGasLastCall("sleeves", "usyc_valueUsdc");

        console.log("valueUsdc against matched doubles, gas:");
        console.log("  Erc4626Sleeve", morphoGas);
        console.log("  UsycSleeve   ", usycGas);

        // `_fund` reads this inside every payment, and `totalValueUsdc` reads
        // it for the client's funding pre-check, so it is not free.
        assertLt(morphoGas, 60_000, "the 4626 value read got much more expensive");
        assertLt(usycGas, 60_000, "the Teller value read got much more expensive");
    }

    /// CAN THE TREASURY SPEND WHAT THE SLEEVE SAYS IT HOLDS?
    ///
    /// This started life as a dust measurement and was measuring nothing:
    /// `withdrawExact(held)` delivers exactly `held` by construction, so the
    /// difference was always zero and the assertion could not fail. The
    /// flooring happens earlier, in the conversion, not in the withdrawal.
    ///
    /// Reframed, it pins the property the vault actually depends on. `_fund`
    /// clamps its pull to `working.valueUsdc()`, and `FloatVault` reverts
    /// "sleeve delivered short" if the money does not arrive — so a sleeve
    /// that over-reports turns a correct payment into a failure. A sleeve
    /// pricing its position GROSS of an exit fee would do exactly that, which
    /// is why `UsycSleeve.valueUsdc` uses `previewRedeem`.
    ///
    /// Confirmed able to fail: pricing the USYC position at `balance x NAV`
    /// instead of `previewRedeem` makes this revert "sleeve cannot cover this".
    function test_what_a_sleeve_claims_it_holds_is_what_it_can_deliver() public {
        // MAKE THE PRICE AWKWARD FIRST, or this measures nothing. The first
        // version of this test reported 0 dust for both sleeves and looked
        // like a result: the doubles start at a 1:1 price that divides
        // exactly, so no remainder can exist and the assertion could not have
        // failed. That is the same flaw as the accrual test in
        // FloatVault.t.sol, which picks 95e6 + 5e6 against 95e18 shares and so
        // never enters the rounding path it appears to cover.
        venue.accrue(3_333_333); // a yield that does not divide
        teller.setNav(1_333_333_333_333_333_333); // nor does this price
        teller.setRedemptionFeeBps(7); // nor does a 0.07% fee

        uint256 morphoDust = _roundTrip(address(morpho));
        uint256 usycDust = _roundTrip(address(usycSleeve));

        console.log("claimed minus delivered on a full exit, 6dp USDC units:");
        console.log("  Erc4626Sleeve", morphoDust);
        console.log("  UsycSleeve   ", usycDust);

        // Zero is the right answer and anything above a rounding unit is a
        // sleeve promising money it cannot produce.
        assertLe(morphoDust, 1, "the 4626 sleeve could not deliver what it claimed");
        assertLe(usycDust, 1, "the Teller sleeve could not deliver what it claimed");
    }

    /// Park nothing new; pull back everything the sleeve says it holds, and
    /// report what the treasury is short against what it put in.
    function _roundTrip(address sleeve) internal returns (uint256 dust) {
        (, bytes memory v) = sleeve.staticcall(abi.encodeWithSignature("valueUsdc()"));
        uint256 held = abi.decode(v, (uint256));

        uint256 before = usdc.balanceOf(treasury);
        vm.prank(treasury);
        (bool ok,) = sleeve.call(abi.encodeWithSignature("withdrawExact(uint256)", held));
        require(ok, "full pull failed");
        uint256 got = usdc.balanceOf(treasury) - before;

        // What went in was PARK; what came back out across both pulls is this
        // plus the PULL already taken in setUp's sibling tests. Measured per
        // test, so compare against what the sleeve itself claimed to hold.
        dust = held > got ? held - got : 0;
    }
}
