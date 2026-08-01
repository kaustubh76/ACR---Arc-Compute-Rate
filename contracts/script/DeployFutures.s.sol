// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ACRFutures} from "../src/ACRFutures.sol";

/// @notice Deploy ONLY the cash-settled futures venue against the ALREADY-DEPLOYED
///   oracle — never redeploys ACROracle/AttestationRegistry (that is `Deploy.s.sol`).
///   Reads the existing oracle from env so the future settles against the live feed.
///
///   ACR_ORACLE_ADDRESS=0x4f00e3BD… \
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployFutures.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployFutures is Script {
    function run() external returns (ACRFutures futures) {
        address oracle = vm.envAddress("ACR_ORACLE_ADDRESS"); // the EXISTING oracle
        address usdc = vm.envOr("ACR_USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        uint256 marginBps = vm.envOr("ACR_FUTURES_MARGIN_BPS", uint256(2000));

        require(oracle != address(0), "set ACR_ORACLE_ADDRESS to the deployed oracle");

        vm.startBroadcast();
        futures = new ACRFutures(oracle, usdc, marginBps);
        vm.stopBroadcast();

        console.log("ACRFutures:", address(futures));
        console.log("  oracle:  ", oracle);
        console.log("  usdc:    ", usdc);
        console.log("  marginBps:", marginBps);
    }
}
