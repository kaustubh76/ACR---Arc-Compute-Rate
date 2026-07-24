// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ACROracle} from "../src/ACROracle.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";

/// @notice Deploy the ACR on-chain layer.
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract Deploy is Script {
    function run() external returns (ACROracle oracle, AttestationRegistry registry) {
        vm.startBroadcast();
        oracle = new ACROracle();
        registry = new AttestationRegistry();
        vm.stopBroadcast();
        console.log("ACROracle:          ", address(oracle));
        console.log("AttestationRegistry:", address(registry));
    }
}
