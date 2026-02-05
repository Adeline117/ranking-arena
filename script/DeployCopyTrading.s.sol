// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../contracts/ArenaCopyTrading.sol";

contract DeployCopyTrading is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployerAddress = vm.envAddress("DEPLOYER_ADDRESS");

        // Base Mainnet USDC
        address usdcAddress = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

        vm.startBroadcast(deployerPrivateKey);

        ArenaCopyTrading copyTrading = new ArenaCopyTrading(
            usdcAddress,        // collateral token (USDC)
            deployerAddress,    // initial owner
            100000000,          // min allocation: 100 USDC (6 decimals)
            100,                // platform fee: 1% (100 bps)
            1000,               // trader share: 10% (1000 bps)
            100                 // max followers per trader
        );

        console.log("ArenaCopyTrading deployed at:", address(copyTrading));

        vm.stopBroadcast();
    }
}
