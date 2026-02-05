// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../contracts/ArenaMembership.sol";

contract DeployMembership is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployerAddress = vm.envAddress("DEPLOYER_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        ArenaMembership membership = new ArenaMembership(
            deployerAddress,  // initial owner
            2592000           // default duration (30 days)
        );

        console.log("ArenaMembership deployed at:", address(membership));

        vm.stopBroadcast();
    }
}
