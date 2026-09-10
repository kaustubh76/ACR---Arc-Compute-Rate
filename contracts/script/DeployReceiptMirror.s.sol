// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ReceiptMirror} from "../src/ReceiptMirror.sol";

/// @notice Deploy ONLY the ReceiptMirror — the bridge that puts an off-chain
///   Gateway settlement on chain so the subgraph has a tape to index. Never
///   touches the oracle, the registry or the venue (`Deploy.s.sol` /
///   `DeployFutures.s.sol` own those), and the venue's immutable oracle pointer
///   means it must not: additive beats risky.
///
///   The constructor trusts the deployer as the first signer. In production the
///   mirror is signed by the same Circle developer-controlled wallet that signs
///   oracle prints, so pass its address as ACR_MIRROR_SIGNER and this authorizes
///   it — one trust anchor for prints and for the settlements benchmarked
///   against them.
///
///   ACR_MIRROR_SIGNER=0x8366… \
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployReceiptMirror.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployReceiptMirror is Script {
    function run() external returns (ReceiptMirror mirror) {
        // Default to the deployer when unset, so a local/anvil run needs no env.
        address signer = vm.envOr("ACR_MIRROR_SIGNER", address(0));

        vm.startBroadcast();
        mirror = new ReceiptMirror();
        if (signer != address(0)) {
            mirror.setSigner(signer, true);
        }
        vm.stopBroadcast();

        console.log("ReceiptMirror    :", address(mirror));
        console.log("authorized signer:", signer == address(0) ? msg.sender : signer);
        console.log("Set ACR_RECEIPT_MIRROR_ADDRESS to the address above,");
        console.log("and put it in graph/subgraph.yaml with this deploy's block as startBlock.");
    }
}
