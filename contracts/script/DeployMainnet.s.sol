// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ACROracle} from "../src/ACROracle.sol";
import {ACROracleV2} from "../src/ACROracleV2.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {ACRFutures} from "../src/ACRFutures.sol";
import {ReceiptMirror} from "../src/ReceiptMirror.sol";
import {HumanIdMirror} from "../src/HumanIdMirror.sol";
import {FeedAccessAttestor} from "../src/FeedAccessAttestor.sol";

/// @notice The whole on-chain layer for Arc mainnet, in one broadcast, in the order the
///   dependencies require — and with the custody the audit asked for baked in rather than
///   left to a ceremony (docs/SECURITY-AUDIT.md, C1):
///
///   * the venue settles against **ACROracleV2** (the move bound, the first-print rule),
///     which is why v2 is constructed before it;
///   * every constructor grants the deployer a signer bit; this script sets the press
///     signer and then **revokes the deployer's bit on every contract**, so the deploy key
///     never signs a mainnet print;
///   * if `ACR_EXPECTED_OWNER` is set, `transferOwnership` to it on every owned contract —
///     the `acceptOwnership` half is the owner's own act, deliberately.
///
///   Required env: ACR_USDC_ADDRESS, ACR_PRESS_SIGNER, ACR_HUMANID_SALT_COMMITMENT.
///   Optional: ACR_EXPECTED_OWNER, ACR_MIRROR_SIGNER, ACR_HUMANID_SIGNER (both default to
///   the press), ACR_FUTURES_MARGIN_BPS (2000), ACR_ORACLE_MAX_MOVE_BPS (2000).
///
///   forge script script/DeployMainnet.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployMainnet is Script {
    function run()
        external
        returns (
            ACROracle v1,
            AttestationRegistry registry,
            ACROracleV2 v2,
            ACRFutures futures,
            ReceiptMirror receipts,
            HumanIdMirror humans,
            FeedAccessAttestor attestor
        )
    {
        address usdc = vm.envAddress("ACR_USDC_ADDRESS"); // never defaulted on mainnet
        address press = vm.envAddress("ACR_PRESS_SIGNER");
        require(press != address(0), "ACR_PRESS_SIGNER must be the press custody wallet");
        bytes32 saltCommitment = vm.envBytes32("ACR_HUMANID_SALT_COMMITMENT");
        address mirrorSigner = vm.envOr("ACR_MIRROR_SIGNER", press);
        address humanSigner = vm.envOr("ACR_HUMANID_SIGNER", press);
        address expectedOwner = vm.envOr("ACR_EXPECTED_OWNER", address(0));
        uint256 marginBps = vm.envOr("ACR_FUTURES_MARGIN_BPS", uint256(2_000));
        uint256 maxMoveBps = vm.envOr("ACR_ORACLE_MAX_MOVE_BPS", uint256(2_000));

        vm.startBroadcast();
        address deployer = msg.sender;

        v1 = new ACROracle();
        registry = new AttestationRegistry();
        v2 = new ACROracleV2(maxMoveBps);
        futures = new ACRFutures(address(v2), usdc, marginBps); // settles against v2
        receipts = new ReceiptMirror();
        humans = new HumanIdMirror(saltCommitment);
        attestor = new FeedAccessAttestor();

        // The press signs prints and feed-access attestations; the keeper signs
        // receipt mirrors; the resolver signs human clusters.
        v1.setSigner(press, true);
        v2.setSigner(press, true);
        attestor.setSigner(press, true);
        receipts.setSigner(mirrorSigner, true);
        humans.setSigner(humanSigner, true);

        // Retire the deploy key as a signer everywhere a constructor granted it.
        // Guarded so a press equal to the deployer (a local rehearsal) is not
        // silently un-signed.
        if (press != deployer) {
            v1.setSigner(deployer, false);
            v2.setSigner(deployer, false);
            attestor.setSigner(deployer, false);
        }
        if (mirrorSigner != deployer) receipts.setSigner(deployer, false);
        if (humanSigner != deployer) humans.setSigner(deployer, false);

        // Start the hand-over. Each `acceptOwnership` is the new owner's own act.
        if (expectedOwner != address(0) && expectedOwner != deployer) {
            v1.transferOwnership(expectedOwner);
            v2.transferOwnership(expectedOwner);
            futures.transferOwnership(expectedOwner);
            receipts.transferOwnership(expectedOwner);
            humans.transferOwnership(expectedOwner);
            attestor.transferOwnership(expectedOwner);
        }
        vm.stopBroadcast();

        console.log("ACROracle (v1)     :", address(v1));
        console.log("AttestationRegistry:", address(registry));
        console.log("ACROracleV2        :", address(v2), " MAX_MOVE_BPS", maxMoveBps);
        console.log("ACRFutures         :", address(futures), " settles against v2");
        console.log("ReceiptMirror      :", address(receipts));
        console.log("HumanIdMirror      :", address(humans));
        console.log("FeedAccessAttestor :", address(attestor));
        console.log("");
        console.log("press signer       :", press);
        console.log("deploy key signs   : nothing");
        if (expectedOwner != address(0) && expectedOwner != deployer) {
            console.log("ownership pending  :", expectedOwner);
            console.log("  -> acceptOwnership() FROM that address on all six contracts, then make verify-mainnet");
        } else {
            console.log("ownership          : still the deploy key -- set ACR_EXPECTED_OWNER (docs/MAINNET_RUNBOOK.md)");
        }
    }
}
