// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ACROracleV2} from "../src/ACROracleV2.sol";

/// @notice Deploy ACROracleV2 — the print that says how it was made.
///
///   DOES NOT REPLACE v1. `ACRFutures.oracle` is immutable and points at the v1
///   oracle permanently, and `ACRFutures.settle()` refuses a print older than
///   two hours. If v1 stopped receiving prints, every expired open series would
///   become unsettleable and its collateral would sit stranded until v1 printed
///   again. So after this deploy the keeper posts to BOTH, and
///   `ACR_ORACLE_ADDRESS` keeps pointing at v1.
///
///   ORDER MATTERS AND IS NOT RECOVERABLE. `postPrint` enforces strictly
///   monotone economic timestamps, so once v2 takes one LIVE print no earlier
///   one can ever be inserted. Run `make backfill-oracle-v2` before enabling
///   the dual-post, or v2 starts with an empty history and every settlement in
///   the demo window comes back unbenchmarked.
///
///   ACR_ORACLE_V2_SIGNER=0x8366… \
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployOracleV2.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployOracleV2 is Script {
    function run() external returns (ACROracleV2 oracle) {
        // Default to the deployer when unset, so a local/anvil run needs no env.
        address signer = vm.envOr("ACR_ORACLE_V2_SIGNER", address(0));

        vm.startBroadcast();
        oracle = new ACROracleV2();
        if (signer != address(0)) {
            oracle.setSigner(signer, true);
        }
        vm.stopBroadcast();

        console.log("ACROracleV2      :", address(oracle));
        console.log("authorized signer:", signer == address(0) ? msg.sender : signer);
        console.log("");
        console.log("Next, IN THIS ORDER:");
        console.log("  1. set ACR_ORACLE_V2_ADDRESS to the address above");
        console.log("  2. make backfill-oracle-v2   (BEFORE any live post)");
        console.log("  3. add the v2 data source + this deploy's block to graph/subgraph.yaml");
        console.log("Leave ACR_ORACLE_ADDRESS pointing at v1 - the venue settles against it.");
    }
}
