// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FloatVault} from "../src/float/FloatVault.sol";
import {FloatPrintStore} from "../src/float/FloatPrintStore.sol";
import {Erc4626Sleeve} from "../src/float/Sleeves.sol";
import {FloatTestSeller} from "../src/float/FloatTestSeller.sol";
import {ISleeve} from "../src/float/IFloat.sol";

/// @notice Deploy Float: the print store, the treasury, the yield sleeve and the
///   labelled test seller, wired and seeded in ONE broadcast so the set is never
///   half-live. Touches no existing contract — not the oracle, not the registry,
///   not a PolicyWallet. Additive beats risky.
///
///   THE RESTING STATE IS SAFE AND THAT IS DELIBERATE. The vault can hold money
///   and spend none of it until an agent exists and a seller is allowed, which is
///   why neither is a constructor argument. What the constructor does fix is the
///   guest cap, so if 2 USDC is the wrong number for the booth, pass it now:
///   changing it later is a redeploy.
///
///   TWO ARC FACTS THIS SCRIPT EXISTS TO GET RIGHT:
///
///   Gas on Arc is USDC, and a transaction with maxFeePerGas below 20 Gwei is
///   SILENTLY DROPPED by the mempool — no receipt, no error, just nothing. If a
///   broadcast appears to hang, that is the first thing to check, and `--legacy`
///   with an explicit `--gas-price` is the way past it.
///
///   The working sleeve points at a real ERC-4626 USDC vault. On Arc Testnet that
///   is the Morpho Vault V2 which Circle's Earn Kit discovers, and the sleeve's
///   constructor asserts `venue.asset() == usdc` so a wrong address fails here
///   rather than by swallowing a deposit. There is no reserve sleeve: a zero
///   address means "no reserve" and the vault skips it, which is honest, where a
///   mock yield venue would not be.
///
///   FLOAT_EXECUTOR=0x…       required. The backend's submitting key. It may
///                            submit and nothing else, and it must NOT be the
///                            approver — one key that can both park a spend and
///                            approve it is not a human checkpoint.
///   FLOAT_APPROVER=0x…       whose signature releases a parked spend.
///                            Defaults to the deployer.
///   FLOAT_KEEPER=0x…         prints and rebalances. Defaults to the executor.
///   FLOAT_REGISTRAR=0x…      may write the guest template and nothing else.
///   FLOAT_STUDIO=0x…         the policy compiler's deploy key.
///   FLOAT_VENUE=0x…          the ERC-4626 USDC vault.
///   FLOAT_GUEST_CAP=2000000  guest daily cap, USDC 1e6. Fixed at deploy.
///   ACR_USDC_ADDRESS=0x3600…0000
///
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployFloat.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployFloat is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    // Morpho Vault V2 on Arc Testnet, as published in Circle's earn-kit package.
    // Verified live: asset() is Arc USDC, zero fees, and all four Vault V2
    // transfer gates are the zero address — which is why a CONTRACT may hold
    // shares here, and therefore why the just-in-time pull can be atomic.
    // (Plain comments, not doc comments: a leading @ in a /// line is read as a
    // documentation tag and fails the build.)
    address internal constant ARC_TESTNET_MORPHO_VAULT =
        0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88;

    bytes32 internal constant SCOUT = keccak256("scout");
    bytes32 internal constant WASTER = keccak256("waster");

    function run()
        external
        returns (FloatVault vault, FloatPrintStore store, Erc4626Sleeve sleeve, FloatTestSeller seller)
    {
        address usdc = vm.envOr("ACR_USDC_ADDRESS", ARC_USDC);
        address venue = vm.envOr("FLOAT_VENUE", ARC_TESTNET_MORPHO_VAULT);
        // ALL FIVE ROLES ARE REQUIRED, and that is a deliberate change from
        // defaulting them to `msg.sender`.
        //
        // The constructor runs under `vm.startBroadcast()`, so `owner` is always
        // the broadcasting key — but these five are read OUTSIDE the broadcast,
        // where `msg.sender` is whatever forge resolved for the script call, not
        // necessarily the key paying for it. Default them and the approver, the
        // guest registrar and the studio deployer can all silently become an
        // address nobody holds: `registerGuest` then reverts "not registrar"
        // forever, the human path is dead, and `require(executor != approver)`
        // does not catch it because they differ perfectly well. The owner being
        // correct while three roles are wrong is exactly the asymmetry that
        // makes it invisible until the demo.
        //
        // A missing variable now fails this script before it spends anything.
        address executor = vm.envAddress("FLOAT_EXECUTOR");
        address approver = vm.envAddress("FLOAT_APPROVER");
        address keeper = vm.envAddress("FLOAT_KEEPER");
        address registrar = vm.envAddress("FLOAT_REGISTRAR");
        address studio = vm.envAddress("FLOAT_STUDIO");
        uint256 guestCap = vm.envOr("FLOAT_GUEST_CAP", uint256(2e6));

        require(executor != address(0), "FLOAT_EXECUTOR is required");
        require(executor != approver, "executor and approver must be different keys");

        vm.startBroadcast();

        store = new FloatPrintStore();
        store.setSigner(keeper, true);

        vault = new FloatVault(usdc, address(store), guestCap);
        sleeve = new Erc4626Sleeve(venue, usdc, address(vault));
        seller = new FloatTestSeller(usdc);

        vault.wire(executor, keeper, approver, registrar, studio, sleeve, ISleeve(address(0)));

        // The seed policy. Deliberately tight: a 1% band is narrower than any
        // honest quote jitter and far narrower than an overcharge, so the demo's
        // refusal is a real refusal rather than a threshold tuned to fire.
        vault.setPolicy(
            FloatVault.Policy({
                maxPremiumBps: 100,
                humanMaxPremiumBps: 2000,
                maxPrintAge: 1800,
                upperBandBps: 1500,
                lowerBandBps: 1000,
                workingShareBps: 10_000,
                bufferHours: 48,
                minTicketUsdc: 1e6
            }),
            keccak256("float.policy.seed.v1"),
            0,
            0,
            bytes32(0),
            bytes32(0)
        );

        // scout is the hero; waster is the foil that gets refused and frozen.
        // Both start unfrozen so the policy demo has something to change.
        vault.setAgent(SCOUT, 25e6, 5e6, false, keccak256("float.agent.scout.v1"), 0, 0, bytes32(0), bytes32(0));
        vault.setAgent(WASTER, 25e6, 5e6, false, keccak256("float.agent.waster.v1"), 0, 0, bytes32(0), bytes32(0));
        vault.allowSeller(SCOUT, address(seller), true, 0, 0, bytes32(0), bytes32(0));
        vault.allowSeller(WASTER, address(seller), true, 0, 0, bytes32(0), bytes32(0));
        vault.allowGuestSeller(address(seller), true);

        vm.stopBroadcast();

        console.log("FloatVault      :", address(vault));
        console.log("FloatPrintStore :", address(store));
        console.log("Erc4626Sleeve   :", address(sleeve));
        console.log("FloatTestSeller :", address(seller));
        console.log("venue (4626)    :", venue);
        console.log("usdc            :", usdc);
        console.log("owner           :", msg.sender);
        console.log("executor        :", executor);
        console.log("approver        :", approver);
        console.log("keeper          :", keeper);
        console.log("guest cap (1e6) :", guestCap);
        console.log("");
        console.log("The vault holds nothing yet. FUND IT WITH AN ERC-20 TRANSFER, never a");
        console.log("native value send: Arc's USDC at 0x3600 is the same ledger as gas, but");
        console.log("these contracts have no receive() and a value send to them reverts.");
        console.log("  cast send 0x3600000000000000000000000000000000000000 \\");
        console.log("    'transfer(address,uint256)' <vault> 8000000 --rpc-url ... --private-key ...");
        console.log("Then run the keeper so a print exists: every spend is refused");
        console.log("'no print for index' until one does.");
        console.log("");

        // A PASTE-READY RECORD. Thirteen fields have to reach
        // float/deployments/<net>.json before any TypeScript here works, and
        // asking a human to transcribe them from a log at 3am — after the money
        // is already spent — is how a typo costs the whole attempt. Copy this
        // block into that file instead.
        console.log("--- copy into float/deployments/arc-testnet.json ---");
        console.log("{");
        console.log(string.concat('  "net": "arc-testnet",'));
        console.log(string.concat('  "chainId": ', vm.toString(block.chainid), ","));
        console.log(string.concat('  "usdc": "', vm.toString(usdc), '",'));
        console.log(string.concat('  "venue": "', vm.toString(venue), '",'));
        console.log(string.concat('  "printStore": "', vm.toString(address(store)), '",'));
        console.log(string.concat('  "vault": "', vm.toString(address(vault)), '",'));
        console.log(string.concat('  "sleeve": "', vm.toString(address(sleeve)), '",'));
        console.log(string.concat('  "seller": "', vm.toString(address(seller)), '",'));
        console.log(string.concat('  "deployer": "', vm.toString(msg.sender), '",'));
        console.log(string.concat('  "executor": "', vm.toString(executor), '",'));
        console.log(string.concat('  "keeper": "', vm.toString(keeper), '",'));
        console.log(string.concat('  "approver": "', vm.toString(approver), '",'));
        console.log(string.concat('  "deployedAt": "', vm.toString(block.timestamp), '"'));
        console.log("}");
        console.log("--- end ---");
    }
}
