// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcFlightCover
/// @notice Parametric flight-delay cover on Arc. Underwriters pool USDC; a traveller buys a
///         policy for a flight up to a cut-off before departure; a k-of-n reporter committee
///         posts the actual delay; if it reaches the threshold (or the flight is cancelled) the
///         fixed payout goes to the traveller automatically — no claim form, no adjuster.
///
/// @dev Solvency is structural: every sold policy reserves its full payout, and a policy can
///      only be sold if free capital covers it. Underwriters can withdraw only free capital.
///      If reporters never reach quorum within the report window, the traveller gets the
///      premium back.
///
///      Arc-specific: premiums, payouts and underwriting capital are all native USDC — no
///      stablecoin/volatile-token mismatch between what is insured and what backs it. Finality on
///      inclusion means the payout lands while the traveller is still at the gate. Settlement is
///      permissionless, so a keeper (or the traveller) triggers it with fractions of a cent of gas.
contract ArcFlightCover {
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;

    // Market parameters, fixed at deployment so every policy is sold on the same terms.
    uint256 public immutable premium;
    uint256 public immutable payout;
    uint32 public immutable delayThresholdMinutes;
    uint32 public immutable saleCutoff; // seconds before departure when sales stop
    uint32 public immutable reportWindow; // seconds after departure to reach quorum
    uint8 public immutable quorum;

    enum Outcome {
        Pending,
        OnTime, // delay below threshold
        Delayed, // delay ≥ threshold or cancelled
        NoData // no quorum within the window
    }

    struct Flight {
        uint64 departure;
        Outcome outcome;
        uint32 delayMinutes;
        uint32 policies;
    }

    struct Policy {
        address holder;
        bytes32 flightKey;
        bool settled;
    }

    mapping(address => bool) public isReporter;
    mapping(bytes32 => Flight) public flights;
    mapping(bytes32 => mapping(bytes32 => uint8)) public votes; // flight => keccak(delay,cancelled) => count
    mapping(bytes32 => mapping(address => bool)) public hasReported;
    Policy[] internal _policies;
    mapping(address => uint256[]) internal _policiesOf;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public reserved; // sum of payouts of unsettled policies
    uint256 private _locked = 1;

    event Deposited(address indexed lp, uint256 amount, uint256 shares);
    event Withdrawn(address indexed lp, uint256 amount, uint256 shares);
    event PolicyBought(uint256 indexed policyId, address indexed holder, bytes32 indexed flightKey, string flight, uint64 departure);
    event Reported(bytes32 indexed flightKey, address indexed reporter, uint32 delayMinutes, bool cancelled);
    event Finalized(bytes32 indexed flightKey, Outcome outcome, uint32 delayMinutes);
    event Settled(uint256 indexed policyId, Outcome outcome, uint256 paid);

    error BadParams();
    error ZeroAmount();
    error InsufficientShares();
    error NotEnoughFreeCapital(uint256 free, uint256 needed);
    error WrongPremium(uint256 expected, uint256 sent);
    error SalesClosed();
    error DepartureMismatch();
    error NotReporter();
    error AlreadyReported();
    error NotDeparted();
    error AlreadyFinal();
    error NotFinal();
    error AlreadySettled();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(uint256 premium_, uint256 payout_, uint32 thresholdMinutes, uint32 cutoff, uint32 window,
        address[] memory reporters, uint8 quorum_) {
        if (premium_ == 0 || payout_ <= premium_ || thresholdMinutes == 0 || window < 1 hours) revert BadParams();
        if (quorum_ == 0 || quorum_ > reporters.length) revert BadParams();
        premium = premium_;
        payout = payout_;
        delayThresholdMinutes = thresholdMinutes;
        saleCutoff = cutoff;
        reportWindow = window;
        quorum = quorum_;
        for (uint256 i; i < reporters.length; ++i) {
            if (reporters[i] == address(0) || isReporter[reporters[i]]) revert BadParams();
            isReporter[reporters[i]] = true;
        }
    }

    // ---------------------------------------------------------------------------------
    // Underwriters
    // ---------------------------------------------------------------------------------

    function poolValue() public view returns (uint256) {
        return address(this).balance;
    }

    function freeCapital() public view returns (uint256) {
        uint256 b = address(this).balance;
        return b > reserved ? b - reserved : 0;
    }

    function deposit() external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0) revert ZeroAmount();
        uint256 before = address(this).balance - msg.value;
        shares = totalShares == 0 || before == 0 ? msg.value : (msg.value * totalShares) / before;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, msg.value, shares);
    }

    /// @notice Burn shares for their slice of the pool — only out of free capital, so an
    ///         underwriter can never leave the pool unable to pay a policy already sold.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 amount) {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert InsufficientShares();
        amount = (shares * address(this).balance) / totalShares;
        uint256 free = freeCapital();
        if (amount > free) revert NotEnoughFreeCapital(free, amount);
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        emit Withdrawn(msg.sender, amount, shares);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------------------
    // Travellers
    // ---------------------------------------------------------------------------------

    function flightKey(string calldata flight, uint64 departure) public pure returns (bytes32) {
        return keccak256(abi.encode(flight, departure));
    }

    /// @param flight carrier code + number + date, e.g. "LH1234 2026-10-05"
    function buy(string calldata flight, uint64 departure) external payable returns (uint256 policyId) {
        if (msg.value != premium) revert WrongPremium(premium, msg.value);
        if (block.timestamp + saleCutoff > departure) revert SalesClosed();
        // The premium is already in the balance; it counts toward the reserve it creates.
        uint256 free = freeCapital();
        if (free < payout) revert NotEnoughFreeCapital(free, payout);

        bytes32 key = flightKey(flight, departure);
        Flight storage f = flights[key];
        if (f.departure == 0) f.departure = departure;
        else if (f.departure != departure) revert DepartureMismatch();
        f.policies += 1;
        reserved += payout;

        policyId = _policies.length;
        _policies.push(Policy({holder: msg.sender, flightKey: key, settled: false}));
        _policiesOf[msg.sender].push(policyId);
        emit PolicyBought(policyId, msg.sender, key, flight, departure);
    }

    // ---------------------------------------------------------------------------------
    // Reporters
    // ---------------------------------------------------------------------------------

    function report(bytes32 key, uint32 delayMinutes, bool cancelled) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        Flight storage f = flights[key];
        if (f.departure == 0 || block.timestamp < f.departure) revert NotDeparted();
        if (f.outcome != Outcome.Pending) revert AlreadyFinal();
        if (hasReported[key][msg.sender]) revert AlreadyReported();
        hasReported[key][msg.sender] = true;
        emit Reported(key, msg.sender, delayMinutes, cancelled);
        bytes32 v = keccak256(abi.encode(delayMinutes, cancelled));
        uint8 n = ++votes[key][v];
        if (n >= quorum) {
            f.delayMinutes = delayMinutes;
            f.outcome = cancelled || delayMinutes >= delayThresholdMinutes ? Outcome.Delayed : Outcome.OnTime;
            emit Finalized(key, f.outcome, delayMinutes);
        }
    }

    /// @notice After the report window with no quorum, anyone marks the flight NoData.
    function expire(bytes32 key) external {
        Flight storage f = flights[key];
        if (f.departure == 0) revert NotDeparted();
        if (f.outcome != Outcome.Pending) revert AlreadyFinal();
        if (block.timestamp <= uint256(f.departure) + reportWindow) revert NotFinal();
        f.outcome = Outcome.NoData;
        emit Finalized(key, Outcome.NoData, 0);
    }

    // ---------------------------------------------------------------------------------
    // Settlement (permissionless)
    // ---------------------------------------------------------------------------------

    function settle(uint256 policyId) public nonReentrant returns (uint256 paid) {
        Policy storage p = _policies[policyId];
        if (p.settled) revert AlreadySettled();
        Outcome o = flights[p.flightKey].outcome;
        if (o == Outcome.Pending) revert NotFinal();
        p.settled = true;
        reserved -= payout;
        if (o == Outcome.Delayed) paid = payout;
        else if (o == Outcome.NoData) paid = premium;
        emit Settled(policyId, o, paid);
        if (paid > 0) {
            (bool ok,) = p.holder.call{value: paid}("");
            if (!ok) revert TransferFailed();
        }
    }

    function settleMany(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            if (!_policies[ids[i]].settled && flights[_policies[ids[i]].flightKey].outcome != Outcome.Pending) settle(ids[i]);
        }
    }

    // ---------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------

    function getPolicy(uint256 id) external view returns (Policy memory) {
        return _policies[id];
    }

    function totalPolicies() external view returns (uint256) {
        return _policies.length;
    }

    function policiesOf(address a) external view returns (uint256[] memory) {
        return _policiesOf[a];
    }
}
