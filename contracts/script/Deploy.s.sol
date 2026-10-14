// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ArcFlightCover} from "../src/ArcFlightCover.sol";

/// @notice Deploys one ArcFlightCover market. Terms come from the environment so the market is
///         explicit in the deploy command:
///
///   REPORTERS=0xA,0xB,0xC QUORUM=2 PREMIUM_USDC=1 PAYOUT_USDC=20 \
///   forge script script/Deploy.s.sol:Deploy --rpc-url https://rpc.mainnet.arc.io \
///     --account arc-deployer --broadcast
///
///   Defaults: premium 1 USDC, payout 20 USDC, delay ≥ 120 min, sales stop 6 h before
///   departure, reporters have 2 days to reach quorum.
contract Deploy is Script {
    uint256 internal constant ARC_MAINNET = 5042;
    uint256 internal constant ARC_TESTNET = 5042002;

    function run() external returns (ArcFlightCover market) {
        require(block.chainid == ARC_MAINNET || block.chainid == ARC_TESTNET, "Deploy: refusing to deploy outside Arc");
        address[] memory reporters = vm.envAddress("REPORTERS", ",");
        uint8 quorum = uint8(vm.envOr("QUORUM", uint256(2)));
        uint256 premium = vm.envOr("PREMIUM_USDC", uint256(1)) * 1e18;
        uint256 payout = vm.envOr("PAYOUT_USDC", uint256(20)) * 1e18;

        vm.startBroadcast();
        market = new ArcFlightCover(premium, payout, 120, 6 hours, 2 days, reporters, quorum);
        vm.stopBroadcast();

        require(address(market).code.length > 0, "Deploy: no code at target address");
        require(market.quorum() == quorum && market.payout() == payout, "Deploy: unexpected parameters");
        console.log("");
        console.log("=====================================================");
        console.log("  ArcFlightCover deployed");
        console.log("  Address:     ", address(market));
        console.log("=====================================================");
    }
}
