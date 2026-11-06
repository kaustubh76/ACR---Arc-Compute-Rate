// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {UsycSleeve} from "../src/float/UsycSleeve.sol";
import {SimUsyc, SimUsycTeller} from "../src/sim/SimUsyc.sol";
import {IERC20} from "../src/float/IFloat.sol";

/// @notice Stand up the USYC reserve leg on Arc Testnet **as a simulation**,
///   because Circle's allowlist is a support ticket we cannot clear during the
///   event.
///
///   WHAT IS REAL HERE AND WHAT IS NOT, since the whole value of this depends
///   on nobody being confused:
///
///     REAL      `UsycSleeve` — the same contract, the same bytecode, that
///               would face Circle's Teller. It speaks the Teller's VERIFIED
///               ABI, read from the implementation behind the EIP-1967 proxy.
///     REAL      Every transaction this makes. They are on Arc Testnet and
///               they have hashes anyone can open.
///     A STAND-IN `SimUsycTeller` and `SimUsyc`. Ours, named as such, holding
///               no fund. The real Teller is 0x9fdF14c5…dC105A and it refuses
///               us: `deposit` reverts `NotPermissioned()` (0x7f63bd0f).
///
///   WHAT THIS DELIBERATELY DOES NOT DO. It does not touch the production
///   vault. `DeployFloat.s.sol` wires the treasury's reserve as `address(0)`
///   and says why — *"a zero address means 'no reserve' and the vault skips
///   it, which is honest, where a mock yield venue would not be."* That is
///   right, and it is why the sleeve deployed here answers to the DEPLOYER and
///   not to the treasury: no invented number can reach `totalValueUsdc()`,
///   which the terminal, the funding pre-check and the acceptance suite all
///   read.
///
///   WHAT CHANGES WHEN THE ALLOWLIST LANDS: one constructor argument. Redeploy
///   this sleeve pointing at the real Teller, wire it as the vault's reserve,
///   and acceptance check T15 flips from `NotPermissioned()` on its own,
///   without anyone editing a claim.
///
///   ARC: gas is USDC, and a transaction under 20 Gwei is SILENTLY DROPPED —
///   no receipt, no error. If this appears to hang, that is the first thing to
///   check, and `--legacy` with an explicit `--gas-price` is the way past it.
///
///   This script DEPLOYS ONLY. Seeding the stand-in with USDC happens in
///   `make float-usyc-sim`, because Arc's USDC is precompile-backed and a
///   forge script that moves it cannot be simulated — see the note inline.
contract DeploySimUsyc is Script {
    /// Arc Testnet USDC, which is also the gas token.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// Circle's real Teller. Named here so the two are never confused, and
    /// never called by this script.
    address internal constant REAL_USYC_TELLER = 0x9fdF14c5B14173D74C08Af27AebFf39240dC105A;

    function run() external returns (UsycSleeve sleeve, SimUsycTeller teller, SimUsyc usyc) {
        address usdc = vm.envOr("ACR_USDC_ADDRESS", ARC_USDC);

        vm.startBroadcast();

        usyc = new SimUsyc();
        teller = new SimUsycTeller(IERC20(usdc), usyc);

        // The stand-in permits us, which is the one thing the real Teller will
        // not do yet. Everything else about the shape is the same.
        teller.setPermissioned(true);

        // THE SEEDING IS NOT DONE HERE, and the reason is an Arc fact worth
        // writing down. Arc's USDC at 0x3600…0000 is PRECOMPILE-BACKED: its
        // ERC-20 `transfer` delegates to a precompile at 0x1800…0000, scaling
        // 6 decimals up to 18 on the way, because the ERC-20 view and the gas
        // balance are one ledger. Forge's local EVM cannot execute that
        // precompile, so any script that moves USDC on Arc dies in simulation
        // with `StackUnderflow` — which looks like a bug in the script and is
        // not. `DeployFloat.s.sol` never met this because it only deploys.
        //
        // So this script deploys and nothing else, and stays dry-runnable.
        // `make float-usyc-sim` seeds the stand-in with `cast send`, which runs
        // on chain where the precompile exists.

        // TREASURY IS THE DEPLOYER, NOT THE VAULT. This is the line that keeps
        // the simulation out of the production treasury's accounting.
        sleeve = new UsycSleeve(address(teller), usdc, address(usyc), msg.sender);

        vm.stopBroadcast();

        console.log("--- USYC reserve, SIMULATED ---");
        console.log("SimUsyc (stand-in share token) ", address(usyc));
        console.log("SimUsycTeller (stand-in fund)  ", address(teller));
        console.log("UsycSleeve (REAL contract)     ", address(sleeve));
        console.log("  its treasury is the deployer ", msg.sender);
        console.log("NOT seeded here - `make float-usyc-sim` does that with cast.");
        console.log("");
        console.log("Circle's REAL Teller, not called here:");
        console.log("  ", REAL_USYC_TELLER);
        console.log("  it reverts NotPermissioned() 0x7f63bd0f for us today.");
        console.log("  Acceptance check T15 asks it live on every run.");
    }
}
