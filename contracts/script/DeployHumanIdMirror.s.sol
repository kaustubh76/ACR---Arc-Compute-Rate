// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HumanIdMirror} from "../src/HumanIdMirror.sol";

/// @notice Deploy ONLY the HumanIdMirror — the record of which wallets act for
///   one verified human, so the manipulation bound can be denominated in humans
///   instead of wallets. Never touches the oracle, the registry, the venue or
///   the receipt mirror: additive beats risky, and the venue's immutable oracle
///   pointer means it must not.
///
///   PASS THE COMMITMENT, NEVER THE SALT. `ACR_HUMANID_SALT_COMMITMENT` is
///   already `keccak256(salt)`, computed by the keeper. The salt itself must
///   never be handed to forge: constructor arguments are recorded in
///   `contracts/broadcast/`, which is committed to this repository, so a salt
///   passed here would be published to everyone who clones it — and the whole
///   point of the salt is that holding a nullifier must not let you recompute a
///   wallet's cluster and confirm fleet membership.
///
///   The commitment is immutable. Rotating the salt later means a new
///   deployment, because a resolver that could silently change it could
///   retroactively manufacture whichever grouping flattered a number.
///
///   ACR_HUMANID_SALT_COMMITMENT=0x… \
///   ACR_HUMANID_SIGNER=0x8366… \
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployHumanIdMirror.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployHumanIdMirror is Script {
    function run() external returns (HumanIdMirror mirror) {
        // Default to the deployer when unset, so a local/anvil run needs no env.
        address signer = vm.envOr("ACR_HUMANID_SIGNER", address(0));
        // No default: a placeholder commitment would be worse than none, because
        // it would look like a commitment in the deployed bytecode forever.
        bytes32 saltCommitment = vm.envBytes32("ACR_HUMANID_SALT_COMMITMENT");

        vm.startBroadcast();
        mirror = new HumanIdMirror(saltCommitment);
        if (signer != address(0)) {
            mirror.setSigner(signer, true);
        }
        vm.stopBroadcast();

        console.log("HumanIdMirror    :", address(mirror));
        console.log("authorized signer:", signer == address(0) ? msg.sender : signer);
        console.log("rating window (s):", mirror.RATING_WINDOW());
        console.log("");
        console.log("Next, IN THIS ORDER:");
        console.log("  1. set ACR_HUMANID_MIRROR_ADDRESS to the address above");
        console.log("  2. add the data source + this deploy's block to graph/subgraph.yaml");
        console.log("  3. make graph-deploy VERSION=v0.2.0   (a new version re-indexes)");
        console.log("  4. make resolve-humans   BEFORE any further tape is generated:");
        console.log("     Settlement.human is stamped at finalize and is immutable, so a");
        console.log("     payer that trades before it resolves is non-human forever.");
    }
}
