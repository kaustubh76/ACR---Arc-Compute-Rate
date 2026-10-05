// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";

/// @notice Deploy ONE business's PolicyWallet — the contract that holds its USDC
///   and decides what its agent may move. Never touches the oracle, the registry,
///   the venue or the mirrors: additive beats risky, and this contract shares no
///   state with any of them.
///
///   ONE WALLET PER BUSINESS, deliberately. A shared wallet with per-business
///   categories would make one business's budget a row in a mapping another
///   business's agent can reach if a single `isAgent` entry is wrong. Separate
///   deployments cost about a cent each on Arc and make that class of mistake
///   impossible rather than merely guarded against.
///
///   The deployer becomes the owner and NO agent is authorized: an agent arrives
///   through `setAgent`, and a budget through `setBudget`, so a freshly deployed
///   wallet can hold money and spend none of it. That is the safe resting state,
///   and it is why neither is a constructor argument.
///
///   ACR_USDC_ADDRESS defaults to Arc's native USDC system contract, which is the
///   same address on mainnet and testnet. The ERC-20 view is 6-decimal; every
///   amount this contract stores is in that unit, never the 18-decimal native one.
///
///   ACR_POLICY_AGENT=0x…            (optional) authorize the operator at deploy
///   ACR_USDC_ADDRESS=0x3600…0000    (optional) override the token
///   DEPLOYER_PRIVATE_KEY=0x… \
///   forge script script/DeployPolicyWallet.s.sol --rpc-url $ACR_ARC_RPC_URL --broadcast [--legacy]
contract DeployPolicyWallet is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (PolicyWallet wallet) {
        address usdc = vm.envOr("ACR_USDC_ADDRESS", ARC_USDC);
        address agent = vm.envOr("ACR_POLICY_AGENT", address(0));

        vm.startBroadcast();
        wallet = new PolicyWallet(usdc);
        if (agent != address(0)) {
            wallet.setAgent(agent, true);
        }
        vm.stopBroadcast();

        console.log("PolicyWallet :", address(wallet));
        console.log("USDC         :", usdc);
        console.log("owner        :", msg.sender);
        if (agent != address(0)) {
            console.log("agent        :", agent);
        } else {
            console.log("agent        : none yet (setAgent before the operator can spend)");
        }
        console.log("");
        console.log("No budget is set, so the agent can spend nothing until setBudget runs.");
        console.log("Set ACR_POLICY_WALLET_ADDRESS to the address above.");
    }
}
