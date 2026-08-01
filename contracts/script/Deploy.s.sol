// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ACROracle} from "../src/ACROracle.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {ACRFutures} from "../src/ACRFutures.sol";

/// @notice Deploy the ACR on-chain layer: the reference oracle, the seller
///   attestation registry, and the cash-settled futures venue (settling against
///   the oracle). USDC defaults to Arc's native system-contract address; the
///   futures initial margin defaults to 20% and can be overridden by env.
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract Deploy is Script {
    function run() external returns (ACROracle oracle, AttestationRegistry registry, ACRFutures futures) {
        address usdc = vm.envOr("ACR_USDC_ADDRESS", address(0x3600000000000000000000000000000000000000));
        uint256 marginBps = vm.envOr("ACR_FUTURES_MARGIN_BPS", uint256(2000));

        vm.startBroadcast();
        oracle = new ACROracle();
        registry = new AttestationRegistry();
        futures = new ACRFutures(address(oracle), usdc, marginBps);
        vm.stopBroadcast();

        console.log("ACROracle:          ", address(oracle));
        console.log("AttestationRegistry:", address(registry));
        console.log("ACRFutures:         ", address(futures));
    }
}
