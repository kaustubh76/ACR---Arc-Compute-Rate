// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "./IFloat.sol";

/// @title FloatTestSeller — a labelled counterparty for the demo.
/// @notice Named "Test" in the contract itself, not just in a slide, because a
///         demo that pays a seller the team controls should say so on chain. The
///         quotes come from its HTTP side; this contract only has to be a real
///         address that really receives USDC, so the payment on the explorer is
///         a payment and not a simulation.
/// @dev    `recordJob` is optional bookkeeping for the tape. Payment itself is a
///         plain USDC transfer from the treasury — receipts are read from the
///         treasury's own `Receipt` event, not from here, so a seller that never
///         calls this still gets paid and still shows up.
contract FloatTestSeller {
    IERC20 public immutable usdc;
    address public owner;
    uint256 public jobsRecorded;

    event JobRecorded(bytes32 indexed jobRef, bytes32 indexed index, uint256 units);
    event Swept(address indexed to, uint256 amount);

    constructor(address usdc_) {
        require(usdc_ != address(0), "zero usdc");
        usdc = IERC20(usdc_);
        owner = msg.sender;
    }

    function recordJob(bytes32 jobRef, bytes32 index, uint256 units) external {
        jobsRecorded += 1;
        emit JobRecorded(jobRef, index, units);
    }

    /// @notice Return the demo's money to the treasury so a drained buffer can be
    ///         refilled without another faucet drip — the faucet allows one
    ///         request per asset every two hours, which is slower than a demo
    ///         rehearsal loop.
    function sweep(address to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        require(to != address(0), "zero to");
        require(usdc.transfer(to, amount), "transfer failed");
        emit Swept(to, amount);
    }
}
