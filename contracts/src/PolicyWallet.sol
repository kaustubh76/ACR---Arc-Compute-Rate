// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal ERC-20 surface for USDC (6 decimals on Arc).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PolicyWallet — a business's spending authority, enforced by the chain.
/// @notice An AI agent that spends a company's money needs a limit it cannot
///         reach. A prompt is not that: a prompt is a request, and a model that
///         can be asked can be talked past. This contract holds the business's
///         USDC and is the only thing that can move it, so the agent's authority
///         is whatever this contract says it is and nothing more.
///
///         THE LADDER, and it is only two numbers per category, because a third
///         would be a number somebody could get wrong:
///
///           cap        the most that may leave this category in one period.
///                      Binds EVERYONE — the agent, and the owner's one-off
///                      approval too. Raising it is `setBudget`, a separate
///                      transaction with its own event, which is the point: the
///                      budget changing is itself on the record.
///           perTxLimit the most the AGENT may move in one payment on its own
///                      authority. At or above it, `spend` reverts and the only
///                      path is `spendApproved` — which carries the OWNER's
///                      EIP-712 signature. That is the "threshold above which a
///                      human signs", and it is a key, not a flag in a database.
///
///         REFUSE, NEVER CLAMP. An over-budget payment reverts; it does not pay
///         the remaining headroom. A clamp would turn "I could not afford this"
///         into a smaller payment nobody authorized, and the agent would have no
///         way to tell the two apart. `scripts/hedger.py` reaches the same
///         conclusion off-chain for the same reason.
///
///         EVERY SPEND CARRIES A `decisionHash`, and zero is rejected. It is the
///         keccak of the operator's own decision record — what was billed, what
///         the meter independently counted, the par it was checked against, the
///         rule that fired. The chain therefore holds a commitment to the
///         reasoning BEFORE the money moves, which makes the off-chain ledger
///         TAMPER-EVIDENT rather than merely stored: a record that disagrees
///         with its own hash is a record that was edited afterwards.
///
///         This used to say "replayable", and that was the wrong word. The
///         hash proves a row is the row that was committed to; it does not
///         make the row sufficient to re-derive. Replay needs the decision's
///         INPUTS on the record — the thresholds, the par's denomination and
///         seller count, the screen's gate — and the first nineteen rows this
///         wallet paid predate those fields, so none of them replays. Rows
///         written since do. Tamper-evidence is what this contract gives;
///         replay is a property of the record's own completeness.
///
/// @dev    Mirrors `ReceiptMirror` / `FeedAccessAttestor` idioms on purpose —
///         same domain separator construction, same public digest view, same
///         two-step ownership, same labelled guards — so one reviewer's
///         understanding covers all three. Refusals are NOT events: a revert
///         emits nothing, so the refusal ledger lives off-chain in
///         `ops_actions.record`, which already writes every outcome down
///         including the ones that failed.
contract PolicyWallet {
    // Units, once, so nothing downstream has to guess:
    //   every amount here is USDC on the ERC-20 view, 1e6 — the same unit as
    //   `ReceiptMirror.amountUsdc`, so a budget and a receipt are directly
    //   comparable. It is NOT the 18-decimal native view. Arc renders one asset
    //   both ways (native USDC is the gas token at 18 decimals; the ERC-20 view
    //   at 0x3600…0000 is 6), and `apps/terminal/lib/walletPayer.ts` carries the
    //   same warning for the same reason. Mixing them is a 1e12 error that looks
    //   like a fat finger.
    //   periodLength, deadline, periodStart: unix seconds.

    uint256 internal constant USDC = 1e6;

    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "SpendApproval(bytes32 category,address to,uint256 amount,bytes32 decisionHash,"
        "uint256 nonce,uint64 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    IERC20 public immutable usdc;

    address public owner;
    address public pendingOwner;
    bool public paused;

    /// @notice The agents allowed to spend. Plural, because a business runs one
    ///         operator per concern and revoking one should not stop the others.
    mapping(address => bool) public isAgent;

    /// @notice Strictly increasing, consumed by `spendApproved`. The owner signs
    ///         a specific nonce, so an approval is good exactly once: a vendor
    ///         who is paid twice on one signature is the duplicate-payment bug
    ///         this whole product exists to catch.
    uint256 public approvalNonce;

    struct Budget {
        uint256 cap;
        uint256 spent; // within the current period
        uint256 perTxLimit;
        uint64 periodStart;
        uint64 periodLength;
        bool exists;
    }

    mapping(bytes32 => Budget) internal budgets;

    event AgentSet(address indexed agent, bool allowed);
    event BudgetSet(
        bytes32 indexed category,
        uint256 cap,
        uint256 perTxLimit,
        uint64 periodLength,
        uint64 periodStart
    );
    event PausedSet(bool paused);

    /// @dev Carries the headroom AFTER the spend and the rule that authorized it,
    ///      so the subgraph can index "what was the agent allowed to do, and what
    ///      did it do" without replaying every prior event to derive the balance.
    event Spent(
        bytes32 indexed category,
        address indexed to,
        /// Whoever actually sent the transaction: an agent on the two agent
        /// paths, the owner on `spendAsOwner`. Named `actor` rather than `agent`
        /// because on the owner path it is not an agent, and an event field that
        /// lies about who acted is worse than a longer word.
        address indexed actor,
        uint256 amount,
        bytes32 decisionHash,
        bool ownerApproved,
        uint256 spentInPeriod,
        uint256 cap,
        uint64 periodStart
    );
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address usdc_) {
        require(usdc_ != address(0), "zero usdc");
        usdc = IERC20(usdc_);
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Policy Wallet")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // --- administration ------------------------------------------------------

    function setAgent(address agent, bool allowed) external onlyOwner {
        require(agent != address(0), "zero agent");
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    /// @notice Create or replace a category budget.
    /// @dev    `perTxLimit <= cap` is required: a per-transaction limit above the
    ///         period cap is unreachable, and an unreachable limit reads as a
    ///         limit while enforcing nothing. Both must be non-zero, so a
    ///         half-configured category cannot go live — the agent's authority is
    ///         never accidentally unbounded, and never accidentally zero either.
    ///         Replacing a budget RESETS the period. Said plainly because the
    ///         alternative (carrying `spent` across a cap change) means the first
    ///         period after an increase is silently smaller than the new cap.
    function setBudget(bytes32 category, uint256 cap, uint256 perTxLimit, uint64 periodLength)
        external
        onlyOwner
    {
        require(category != bytes32(0), "zero category");
        require(cap > 0, "zero cap");
        require(perTxLimit > 0, "zero per-tx limit");
        require(perTxLimit <= cap, "per-tx limit above cap");
        require(periodLength > 0, "zero period");

        Budget storage b = budgets[category];
        b.cap = cap;
        b.perTxLimit = perTxLimit;
        b.periodLength = periodLength;
        b.periodStart = uint64(block.timestamp);
        b.spent = 0;
        b.exists = true;

        emit BudgetSet(category, cap, perTxLimit, periodLength, b.periodStart);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice The owner can always retrieve their own money. Deliberately not
    ///         budgeted: a budget constrains the AGENT, and an owner locked out
    ///         of their own treasury by a rule they set would be a reason not to
    ///         run this at all.
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero to");
        require(amount > 0, "zero amount");
        require(usdc.transfer(to, amount), "transfer failed");
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero owner");
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnerTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // --- views ---------------------------------------------------------------
    // The period rolls lazily, so a read that ignored the roll would report a
    // category as exhausted when the new period had in fact already begun. Reads
    // and writes therefore share `_rolled`, rather than each doing the
    // arithmetic its own way.

    /// @dev Whole periods only: a category funded monthly stays on its own
    ///      calendar instead of drifting forward by the gap since the last spend.
    function _rolled(Budget memory b) internal view returns (uint256 spent, uint64 periodStart) {
        if (!b.exists) return (0, 0);
        if (block.timestamp < uint256(b.periodStart) + b.periodLength) {
            return (b.spent, b.periodStart);
        }
        uint64 elapsed = uint64(block.timestamp) - b.periodStart;
        uint64 periods = elapsed / b.periodLength;
        return (0, b.periodStart + periods * b.periodLength);
    }

    function budgetOf(bytes32 category)
        external
        view
        returns (
            bool exists,
            uint256 cap,
            uint256 spent,
            uint256 perTxLimit,
            uint64 periodStart,
            uint64 periodLength
        )
    {
        Budget memory b = budgets[category];
        (uint256 s, uint64 ps) = _rolled(b);
        return (b.exists, b.cap, s, b.perTxLimit, ps, b.periodLength);
    }

    /// @notice What the agent could still spend in this category right now,
    ///         before the per-transaction limit is applied.
    function remaining(bytes32 category) public view returns (uint256) {
        Budget memory b = budgets[category];
        if (!b.exists) return 0;
        (uint256 s,) = _rolled(b);
        return s >= b.cap ? 0 : b.cap - s;
    }

    /// @notice The digest the OWNER signs to authorize one payment at or above
    ///         `perTxLimit`. Exposed so the signer checks itself against the
    ///         chain's own arithmetic rather than a reimplementation of it.
    function approvalDigest(
        bytes32 category,
        address to,
        uint256 amount,
        bytes32 decisionHash,
        uint256 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                APPROVAL_TYPEHASH, category, to, amount, decisionHash, nonce, deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // --- spending ------------------------------------------------------------

    /// @notice The agent's own authority: anything strictly below `perTxLimit`
    ///         and within the period cap.
    function spend(bytes32 category, address to, uint256 amount, bytes32 decisionHash) external {
        Budget memory b = budgets[category];
        require(b.exists, "no such budget");

        // G5 — the escalation threshold. Strictly below, so a limit of 100 means
        // the agent's largest unilateral payment is 99.999999 and 100 goes to the
        // owner. An inclusive limit would make the documented number the first
        // one the agent may NOT send, which is the kind of off-by-one that gets
        // discovered by a payment nobody meant to make.
        require(amount < b.perTxLimit, "needs owner approval");

        _spend(category, to, amount, decisionHash, false, false);
    }

    /// @notice A payment at or above `perTxLimit`, carrying the owner's signature.
    /// @dev    Relaying is permissionless in spirit but gated to an agent here,
    ///         because `to` and `amount` are already fixed by the signature and a
    ///         third-party relay buys nothing: the agent is the party with a
    ///         reason to submit, and keeping the caller an agent means every
    ///         `Spent` event names the operator that acted.
    ///
    ///         The period cap STILL BINDS. An approval lifts the per-transaction
    ///         ceiling, not the budget: the owner approving one invoice should not
    ///         silently reopen a category they closed. If the cap is genuinely
    ///         wrong, `setBudget` says so on the record.
    function spendApproved(
        bytes32 category,
        address to,
        uint256 amount,
        bytes32 decisionHash,
        uint64 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(budgets[category].exists, "no such budget");
        require(block.timestamp <= deadline, "approval expired");

        address signer = ecrecover(
            approvalDigest(category, to, amount, decisionHash, approvalNonce, deadline), v, r, s
        );
        require(signer != address(0) && signer == owner, "not owner signature");

        // Consumed before the transfer, so a re-entrant call cannot reuse it.
        approvalNonce += 1;

        _spend(category, to, amount, decisionHash, true, false);
    }

    /// @notice The owner paying an escalated obligation from their own wallet.
    /// @dev    THIS IS THE THRESHOLD MADE LITERAL. Above `perTxLimit` the agent's
    ///         `spend` reverts, and this is the only other way the money moves:
    ///         `msg.sender` must BE the owner. Not a signature the agent relays,
    ///         not a flag in a database somebody can set — the owner's own wallet
    ///         sends the transaction, and the explorer shows it.
    ///
    ///         It exists because `ecrecover` cannot check a smart-contract
    ///         account (`docs/WALLETS.md` C1), so an owner whose wallet is a
    ///         Circle PIN-secured SCA could never clear `spendApproved`. Calling
    ///         the contract needs no signature scheme at all, which is also why
    ///         there is no nonce here to go stale.
    ///
    ///         No `perTxLimit` check: that limit bounds the AGENT. The cap still
    ///         binds, because the cap is the budget and the owner closing a
    ///         category should not be undone by the owner paying one invoice.
    ///         `setBudget` is how a budget changes, on the record.
    function spendAsOwner(bytes32 category, address to, uint256 amount, bytes32 decisionHash)
        external
    {
        require(budgets[category].exists, "no such budget");
        _spend(category, to, amount, decisionHash, true, true);
    }

    function _spend(
        bytes32 category,
        address to,
        uint256 amount,
        bytes32 decisionHash,
        bool ownerApproved,
        bool byOwner
    ) internal {
        // G1 — the kill switch outranks every authority below it, including the
        // owner's own wallet: a paused wallet is paused. Checked before the
        // authorization below so that stays true for every path.
        require(!paused, "paused");

        // G2 — who may move money, and the two answers are not interchangeable.
        // An agent on the agent paths (including when it relays the owner's
        // signature, so the event names the operator that acted); the owner and
        // only the owner on `spendAsOwner`. An agent must not reach the owner's
        // path, or the threshold would be a suggestion.
        if (byOwner) {
            require(msg.sender == owner, "not owner");
        } else {
            require(isAgent[msg.sender], "not agent");
        }

        // G3 — a payment with no recipient, no value, or no reasoning attached is
        // not a payment this contract will make. `decisionHash` is the commitment
        // to the record; zero would let the agent pay first and write afterwards.
        require(to != address(0), "zero to");
        require(amount > 0, "zero amount");
        require(decisionHash != bytes32(0), "zero decision hash");

        Budget storage b = budgets[category];

        // G4 — roll the period before measuring it, or the first payment of a new
        // month is refused against last month's spend.
        (uint256 spent, uint64 periodStart) = _rolled(b);

        // G6 — the budget. Refuse, never clamp (see the contract notes).
        require(spent + amount <= b.cap, "over category budget");

        b.spent = spent + amount;
        b.periodStart = periodStart;

        require(usdc.transfer(to, amount), "transfer failed");

        emit Spent(
            category,
            to,
            msg.sender,
            amount,
            decisionHash,
            ownerApproved,
            b.spent,
            b.cap,
            periodStart
        );
    }
}
