// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ACROracle} from "../src/ACROracle.sol";
import {ACRFutures} from "../src/ACRFutures.sol";

/// @notice A 6-decimals token that RE-ENTERS its caller mid-transfer.
///
/// @dev    `MockUSDC` is deliberately not reused and not subclassed: its
///         `transfer`/`transferFrom` are `external`, so there is nothing to
///         override, and the whole point here is a token that does something a
///         well-behaved one never does. The surface is the same four functions
///         plus the two events, for the same reason `MockUSDC` carries them —
///         code that verifies a payment reads LOGS, and a silent mock makes a
///         log-reading verifier see every payment as zero.
///
///         THIS TOKEN CANNOT EXIST ON ARC. `ACRFutures.usdc` is immutable and
///         set at construction, and on Arc it is the native system contract at
///         `0x3600…0000`. So this is not a threat model; it is the only way to
///         observe a lock whose real callees are all trusted.
contract ReenteringUSDC {
    string public constant name = "Re-entering USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    address public target;
    bytes public payload;
    bool public tried;
    bool public succeeded;
    /// WHY the re-entry failed, not merely that it did. A bare `!succeeded`
    /// cannot tell a lock from a balance check, and asserting the wrong one is
    /// how a reentrancy test comes to prove something other than its name.
    bytes public lastError;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _fire() internal {
        if (target != address(0) && payload.length > 0 && !tried) {
            tried = true;
            (succeeded, lastError) = target.call(payload);
        }
    }

    /// @notice The revert string the re-entry came back with, or "" if it did
    ///         not revert with one.
    /// @dev    `require(cond, "msg")` reverts as `Error(string)`: selector
    ///         `0x08c379a0` then an abi-encoded string. Anything else — a
    ///         custom error, a bare revert — has no string, and "" is returned
    ///         so a test asserting a specific message FAILS rather than
    ///         matching on a decode that merely happened to work.
    function lastErrorMessage() external view returns (string memory) {
        bytes memory e = lastError;
        if (e.length < 4) return "";
        if (e[0] != 0x08 || e[1] != 0xc3 || e[2] != 0x79 || e[3] != 0xa0) return "";
        bytes memory body = new bytes(e.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = e[i + 4];
        }
        return abi.decode(body, (string));
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        _fire(); // the hostile part
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        _fire(); // the hostile part
        return true;
    }
}

/// @notice The hand-rolled `nonReentrant` lock on `ACRFutures`, given a witness.
///
/// `docs/SECURITY-AUDIT.md` lists it under **"Verified clean — stated so nobody
/// re-audits it"**: *"Hand-rolled `nonReentrant` used correctly with
/// checks-effects-interactions."* Before this file that claim rested entirely on
/// reading the code — `grep -n "reentrant"` matched two lines of source,
/// `ACRFutures.sol:143` and `FloatVault.sol:294`, and NO test anywhere. The
/// lock guards five money-moving functions (`postCollateral`,
/// `withdrawCollateral`, `trade`, `settle`, `settleStale`) and nothing
/// exercised it.
///
/// WHAT THESE TESTS DO AND DO NOT CLAIM. `ACRFutures.usdc` and
/// `ACRFutures.oracle` are both immutable and set at construction, and on Arc
/// the token is the native system contract. There is therefore NO re-entry path
/// in production and these tests do not assert one. They assert that the
/// mechanism the audit credits actually refuses a re-entry — which is what
/// "used correctly" has to mean if it means anything.
///
/// THE TWO GUARDED FUNCTIONS ARE NOT ORDERED THE SAME WAY, and that is the
/// finding worth keeping:
///
///   `withdrawCollateral` is strict checks-effects-interactions —
///   `collateral[seriesId][msg.sender] = remaining` (`ACRFutures.sol:240`)
///   precedes `usdc.transfer` (`:241`). So even with the lock removed, a
///   re-entrant withdrawal reads the already-decremented balance and is
///   refused by `require(amount <= bal, "insufficient")`. The lock is depth.
///
///   `postCollateral` is the other way round — `usdc.transferFrom` (`:223`)
///   precedes `collateral[...] += amount` (`:224`). The effect follows the
///   interaction, so there is no CEI backstop there and the lock is the only
///   thing refusing a re-entry. It is still not a theft, because `_join` is
///   idempotent (`:460`) and each re-entrant credit is matched by its own
///   transfer, but the audit's "with checks-effects-interactions" does not
///   describe this function.
///
/// Both negative controls were run by deleting the modifier and watching these
/// tests go red; the outcomes are recorded in `docs/SECURITY-AUDIT.md`.
contract ACRFuturesReentrancyTest is Test {
    ACROracle oracle;
    ACRFutures futures;
    ReenteringUSDC usdc;

    bytes32 constant INF = bytes32("ACR-INF");
    uint256 constant MULT = 1000;
    uint256 constant MARGIN_BPS = 2000;

    uint256 signerPk = 0xA11CE;
    address maker;

    /// The hostile token holds its own collateral position, so a re-entrant
    /// call is judged on a real balance rather than bouncing off "no series".
    /// Without that the negative control would report `"insufficient"` for the
    /// trivial reason that the caller never had anything.
    uint256 constant POSITION = 100e6;

    function setUp() public {
        vm.warp(1_000_000);

        oracle = new ACROracle();
        oracle.setSigner(vm.addr(signerPk), true);
        _postPrint(0.5e18, 100);

        usdc = new ReenteringUSDC();
        futures = new ACRFutures(address(oracle), address(usdc), MARGIN_BPS);

        maker = makeAddr("maker");
        futures.openSeries(INF, uint64(block.timestamp + 7 days), MULT, maker);

        // Fund the token itself and let it post for its own account. It never
        // trades, so its required margin stays zero and the whole balance is
        // free to withdraw — which is what makes the full-exit case below the
        // one where a second withdrawal would have to come from someone else's
        // money.
        usdc.mint(address(usdc), POSITION);
        // The approval has to come FROM the token, not from this test contract:
        // `allowance` is keyed on the owner, and approving as the test sets
        // `allowance[test][futures]` while `transferFrom` reads
        // `allowance[usdc][futures]`. The first draft failed `setUp` with a
        // bare "allowance" for exactly that.
        vm.prank(address(usdc));
        usdc.approve(address(futures), type(uint256).max);
        vm.prank(address(usdc));
        futures.postCollateral(0, POSITION);
    }

    function _postPrint(uint256 value, uint64 ts) internal {
        uint256 lo = value * 96 / 100;
        uint256 hi = value * 104 / 100;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerPk, oracle.printDigest(INF, value, lo, hi, 1000e6, ts));
        oracle.postPrint(INF, value, lo, hi, 1000e6, ts, v, r, s);
    }

    /// The CEI-ordered one. The lock answers first; `"insufficient"` is what
    /// would answer in its absence.
    function test_the_lock_refuses_a_reentrant_withdrawal() public {
        usdc.arm(
            address(futures), abi.encodeCall(ACRFutures.withdrawCollateral, (0, POSITION))
        );

        vm.prank(address(usdc));
        futures.withdrawCollateral(0, POSITION);

        assertTrue(usdc.tried(), "the token did try to re-enter");
        assertFalse(usdc.succeeded(), "and the re-entrant withdrawal was refused");
        assertEq(
            usdc.lastErrorMessage(),
            "reentrant",
            "the LOCK refused it - any other string means a different defence answered"
        );
        // Exactly one exit: the position is empty and nothing extra was paid.
        assertEq(futures.collateral(0, address(usdc)), 0, "withdrawn once");
        assertEq(usdc.balanceOf(address(futures)), 0, "and the pool is not short");
    }

    /// The one with no checks-effects-interactions backstop, where the lock is
    /// the only defence rather than the second.
    function test_the_lock_refuses_a_reentrant_deposit() public {
        // TWICE the deposit, so the re-entrant call has the means to complete.
        // With only one deposit's worth, the first negative control reported
        // `"balance"` — the token's own funds running out, not any defence in
        // `ACRFutures` — and a test whose attacker cannot afford the attack
        // proves nothing about the lock.
        usdc.mint(address(usdc), POSITION * 2);
        usdc.arm(address(futures), abi.encodeCall(ACRFutures.postCollateral, (0, POSITION)));

        vm.prank(address(usdc));
        futures.postCollateral(0, POSITION);

        assertTrue(usdc.tried(), "the token did try to re-enter");
        assertFalse(usdc.succeeded(), "and the re-entrant deposit was refused");
        assertEq(
            usdc.lastErrorMessage(),
            "reentrant",
            "the LOCK refused it, and here it is the ONLY thing that would have"
        );
        // Credited once for one transfer, which is the invariant that would
        // break if the effect could land twice off a single interaction.
        assertEq(
            futures.collateral(0, address(usdc)),
            POSITION * 2,
            "two honest deposits, credited twice - not three off two transfers"
        );
    }
}
