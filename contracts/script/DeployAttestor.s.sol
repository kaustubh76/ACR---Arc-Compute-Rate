// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FeedAccessAttestor} from "../src/FeedAccessAttestor.sol";

/// @notice Deploy ONLY the FeedAccessAttestor — the bridge that makes an
///   off-chain x402 settlement checkable on-chain. Never touches the oracle,
///   the registry or the venue (those are `Deploy.s.sol` / `DeployFutures.s.sol`).
///
///   The constructor trusts the deployer as the first signer. In production the
///   attestations are signed by the Circle developer-controlled wallet that
///   already signs oracle prints, so pass its address as ACR_ATTEST_SIGNER and
///   this authorizes it — the same `setSigner` pattern ACROracle uses, so the
///   trust anchor a judge has already verified is the one that mints receipts.
///
///   ACR_ATTEST_SIGNER=0x8366… \
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployAttestor.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployAttestor is Script {
    function run() external returns (FeedAccessAttestor attestor) {
        // Default to the deployer when unset, so a local/anvil run needs no env.
        address signer = vm.envOr("ACR_ATTEST_SIGNER", address(0));

        vm.startBroadcast();
        attestor = new FeedAccessAttestor();
        if (signer != address(0)) {
            attestor.setSigner(signer, true);
        }
        vm.stopBroadcast();

        console.log("FeedAccessAttestor:", address(attestor));
        console.log("authorized signer :", signer == address(0) ? msg.sender : signer);
        console.log("Set ATTESTOR_ADDRESS to the address above.");
    }
}
