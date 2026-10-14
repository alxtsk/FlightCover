// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcFlightCover} from "../src/ArcFlightCover.sol";

contract ArcFlightCoverTest is Test {
    ArcFlightCover internal fc;
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    address internal traveller = makeAddr("traveller");
    address internal r1 = makeAddr("r1");
    address internal r2 = makeAddr("r2");
    address internal r3 = makeAddr("r3");
    uint256 internal constant PREMIUM = 2 ether;
    uint256 internal constant PAYOUT = 50 ether;
    uint64 internal dep;

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory reps = new address[](3);
        reps[0] = r1;
        reps[1] = r2;
        reps[2] = r3;
        fc = new ArcFlightCover(PREMIUM, PAYOUT, 120, 6 hours, 2 days, reps, 2);
        vm.deal(lp, 1_000 ether);
        vm.deal(lp2, 1_000 ether);
        vm.deal(traveller, 100 ether);
        dep = uint64(block.timestamp + 3 days);
        vm.prank(lp);
        fc.deposit{value: 100 ether}();
    }

    function _buy() internal returns (uint256 id) {
        vm.prank(traveller);
        id = fc.buy{value: PREMIUM}("LH1234 2026-10-05", dep);
    }

    function _report(bytes32 key, uint32 delay, bool cancelled) internal {
        vm.prank(r1);
        fc.report(key, delay, cancelled);
        vm.prank(r2);
        fc.report(key, delay, cancelled);
    }

    function test_delayedPaysOut() public {
        uint256 id = _buy();
        assertEq(fc.reserved(), PAYOUT);
        vm.warp(dep + 3 hours);
        _report(fc.flightKey("LH1234 2026-10-05", dep), 145, false);
        uint256 before = traveller.balance;
        fc.settle(id); // anyone
        assertEq(traveller.balance - before, PAYOUT);
        assertEq(fc.reserved(), 0);
    }

    function test_cancelledPaysOut_onTimeDoesNot() public {
        uint256 a = _buy();
        vm.prank(traveller);
        uint256 b = fc.buy{value: PREMIUM}("AF77 2026-10-05", dep);
        vm.warp(dep + 1 hours);
        _report(fc.flightKey("LH1234 2026-10-05", dep), 0, true);
        _report(fc.flightKey("AF77 2026-10-05", dep), 30, false);
        uint256 before = traveller.balance;
        fc.settle(a);
        fc.settle(b);
        assertEq(traveller.balance - before, PAYOUT);
        assertEq(uint8(fc.getPolicy(b).settled ? 1 : 0), 1);
    }

    function test_noQuorum_refundsPremiumAfterWindow() public {
        uint256 id = _buy();
        bytes32 key = fc.flightKey("LH1234 2026-10-05", dep);
        vm.warp(dep + 1 hours);
        vm.prank(r1);
        fc.report(key, 200, false);
        vm.prank(r2);
        fc.report(key, 10, false); // disagreement → no quorum
        vm.expectRevert(ArcFlightCover.NotFinal.selector);
        fc.settle(id);
        vm.expectRevert(ArcFlightCover.NotFinal.selector);
        fc.expire(key);
        vm.warp(dep + 2 days + 1);
        fc.expire(key);
        uint256 before = traveller.balance;
        fc.settle(id);
        assertEq(traveller.balance - before, PREMIUM);
    }

    function test_salesCutoffAndSolvency() public {
        vm.warp(dep - 6 hours + 1);
        vm.prank(traveller);
        vm.expectRevert(ArcFlightCover.SalesClosed.selector);
        fc.buy{value: PREMIUM}("LH1 x", dep);

        vm.warp(1_800_000_000);
        // 100 USDC pool: two policies reserve 100; a third cannot be covered.
        _buy();
        vm.prank(traveller);
        fc.buy{value: PREMIUM}("LH1234 2026-10-05", dep);
        vm.prank(traveller);
        vm.expectRevert();
        fc.buy{value: PREMIUM}("LH1234 2026-10-05", dep);
    }

    function test_lpCannotWithdrawReserved() public {
        _buy(); // pool 102, reserved 50, free 52
        uint256 all = fc.sharesOf(lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ArcFlightCover.NotEnoughFreeCapital.selector, 52 ether, 102 ether));
        fc.withdraw(all);
        vm.prank(lp);
        fc.withdraw(all / 2); // 51 ≤ 52 free
        assertGe(address(fc).balance, fc.reserved());
    }

    function test_premiumsAccrueToLps() public {
        _buy();
        vm.warp(dep + 1 hours);
        _report(fc.flightKey("LH1234 2026-10-05", dep), 5, false);
        fc.settle(0);
        uint256 before = lp.balance;
        uint256 all = fc.sharesOf(lp);
        vm.prank(lp);
        fc.withdraw(all);
        assertEq(lp.balance - before, 102 ether, "LP keeps the premium of an on-time flight");
    }

    function test_secondLpGetsFairShares() public {
        _buy(); // pool 102
        vm.prank(lp2);
        uint256 s = fc.deposit{value: 51 ether}();
        assertEq(s, (51 ether * 100 ether) / 102 ether);
    }

    function test_reporterRules() public {
        _buy();
        bytes32 key = fc.flightKey("LH1234 2026-10-05", dep);
        vm.prank(r1);
        vm.expectRevert(ArcFlightCover.NotDeparted.selector);
        fc.report(key, 200, false);
        vm.warp(dep + 1);
        vm.prank(traveller);
        vm.expectRevert(ArcFlightCover.NotReporter.selector);
        fc.report(key, 200, false);
        vm.startPrank(r1);
        fc.report(key, 200, false);
        vm.expectRevert(ArcFlightCover.AlreadyReported.selector);
        fc.report(key, 200, false);
        vm.stopPrank();
    }

    function test_wrongPremium_departureMismatch() public {
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(ArcFlightCover.WrongPremium.selector, PREMIUM, 1 ether));
        fc.buy{value: 1 ether}("X", dep);
    }
}
