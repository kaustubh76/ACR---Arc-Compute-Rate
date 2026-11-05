// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, IFloatPrices, ISleeve} from "./IFloat.sol";

/// @title FloatVault — an agent treasury that forecasts, earns, and refuses.
/// @notice THE AGENT'S WALLET HOLDS NOTHING. Not "a little", not "a daily
///         allowance" — zero, before and after every payment it causes, and
///         there is a test that asserts exactly that. An agent with a funded
///         wallet is an agent whose worst case is its balance; an agent with an
///         empty wallet and a vault that answers for it has a worst case equal
///         to the rule that answered. This contract is that rule.
///
///         THREE THINGS IT DOES THAT A SPENDING LIMIT DOES NOT:
///
///         1. IT PRICES THE PURCHASE. Every request names the `printId` of the
///            compute price it was quoted against, and the vault recomputes the
///            fair total itself and refuses anything above a band. A limit asks
///            "is this under the cap"; this asks "is this a fair price", which is
///            the question an overcharge actually fails. The band is the demo:
///            rig a seller to quote 3x and the chain says no, in English, in a
///            log anyone can read.
///
///         2. IT FUNDS JUST IN TIME. Idle float lives in a yield sleeve. When a
///            payment arrives and the buffer is short, the vault pulls the EXACT
///            shortfall out of the sleeve and pays the seller in the same
///            transaction. The money was earning yield until the block it was
///            spent in.
///
///         3. IT PARKS, RATHER THAN DENIES, WHAT IT CANNOT AUTHORIZE. Over the
///            per-request threshold the request is not refused — it opens a
///            checkpoint on chain and waits for a human's single-use signature
///            bound to that exact request. An approval WIDENS the band; it never
///            removes it. A human can authorise paying more than usual. Nobody
///            can authorise paying an unpriced amount to an unapproved seller.
///
///         A REFUSAL IS AN EVENT, NOT A REVERT — and this is a deliberate
///         inversion of `PolicyWallet`, which states the opposite ("Refusals are
///         NOT events: a revert emits nothing"). That is right for a wallet whose
///         refusal ledger is an off-chain file we control. It is wrong here,
///         because Float's refusals are the product being demonstrated: a judge
///         rigs a seller, presses a button, and has to be able to open the chain
///         and read why it failed. A revert would discard the log and leave a
///         failed transaction with nothing in it. So `requestSpend` returns a
///         boolean and emits `Denied` with a machine code AND a sentence, and the
///         nonce is burned either way so a refused request cannot be re-run later
///         when conditions have drifted.
///
/// @dev    Deliberately mirrors `PolicyWallet` where the problems are the same —
///         `_rolled`'s whole-period arithmetic, effects-before-token-call, the
///         public digest view, hand-rolled EIP-712 with no OpenZeppelin (this
///         repo vendors only forge-std), two-step ownership, labelled guards —
///         so a reviewer who knows that contract already knows this one.
contract FloatVault {
    // =========================================================================
    // UNITS. Stated once, because the one bug that would silently disable the
    // headline feature is a units bug.
    //
    //   amounts  — USDC on Arc's ERC-20 view, 1e6. NOT the 18-decimal native
    //              view of the same asset. Mixing them is a 1e12 error.
    //   priceWad — USD per bundle of the resource, 1e18, from the print store.
    //   units    — a dimensionless integer count of bundles.
    //
    // The ONLY conversion in this contract is:
    //
    //      fairUsdc6 = priceWad * units / 1e12
    //
    // and it appears exactly once, in `_check`. Multiply before dividing: the
    // other order (`priceWad / 1e12 * units`) truncates the price to zero for
    // anything cheaper than a millionth of a dollar per bundle.
    //
    // Writing `fair = priceWad * units` and comparing it to a 1e6 quote — which
    // is what this design's first draft did — makes `fair` 1e12 too large, so
    // the band can NEVER fire and a 3x overcharge sails through. The feature
    // would look implemented and be absent. `test_the_fair_band_is_denominated
    // _in_usdc_not_wad` exists to keep it that way.
    // =========================================================================

    uint256 internal constant WAD_TO_USDC = 1e12;
    /// A count no honest invoice reaches, bounding both the multiply and the
    /// basis-point division below it.
    uint256 internal constant MAX_UNITS = 1e24;

    uint8 internal constant KIND_SPEND = 1;
    uint8 internal constant KIND_POLICY = 2;

    uint8 internal constant OPEN = 0;
    uint8 internal constant CONSUMED = 1;
    uint8 internal constant DENIED = 2;
    uint8 internal constant EXPIRED = 3;
    uint8 internal constant FAILED = 4;

    /// Denial codes. A code AND a sentence: the sentence is for the human
    /// watching, the code is so the dashboard never has to string-match English
    /// it does not control.
    uint8 public constant D_PAUSED = 1;
    uint8 public constant D_UNKNOWN_AGENT = 2;
    uint8 public constant D_FROZEN = 3;
    uint8 public constant D_SELLER = 4;
    uint8 public constant D_REPLAY = 5;
    uint8 public constant D_UNITS = 6;
    uint8 public constant D_NO_PRINT = 7;
    uint8 public constant D_STALE = 8;
    uint8 public constant D_ROTATED = 9;
    uint8 public constant D_BAND = 10;
    uint8 public constant D_PER_REQUEST = 11;
    uint8 public constant D_DAILY_CAP = 12;

    struct Policy {
        /// The agent's own band above fair, in basis points.
        uint16 maxPremiumBps;
        /// The band after a human approves. Must be >= maxPremiumBps: an
        /// approval widens, never narrows, and never removes.
        uint16 humanMaxPremiumBps;
        /// How old a print may be, in seconds. Settable rather than a constant
        /// because on a flaky RPC you will want to widen it without redeploying.
        uint32 maxPrintAge;
        uint16 upperBandBps;
        uint16 lowerBandBps;
        /// Share of excess that goes to the working sleeve; the rest to reserve.
        uint16 workingShareBps;
        /// Hours of forecast spend the keeper aims to keep liquid.
        uint32 bufferHours;
        /// Below this, do not rebalance at all — fees must never eat the yield.
        uint256 minTicketUsdc;
    }

    struct Agent {
        uint256 dailyCapUsdc;
        /// The most the agent may move on its own authority. At or above it the
        /// request escalates. STRICTLY BELOW is the agent's own authority, the
        /// same convention `PolicyWallet.spend` documents for `perTxLimit`, so a
        /// threshold of 100 means the largest unilateral payment is 99.999999.
        uint256 perRequestUsdc;
        uint256 spent;
        uint64 periodStart;
        uint64 periodLength;
        bool frozen;
        bool guest;
        bool exists;
    }

    struct SpendReq {
        bytes32 agentId;
        address seller;
        bytes32 index;
        uint256 units;
        uint256 quoteTotal;
        uint64 printId;
        bytes32 nonce;
    }

    struct Checkpoint {
        bytes32 reqHash;
        uint64 expiresAt;
        uint8 kind;
        uint8 status;
    }

    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "FloatApproval(uint256 id,bytes32 reqHash,uint64 expiresAt,bytes32 humanBinding)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    IERC20 public immutable usdc;
    IFloatPrices public immutable prices;

    address public owner;
    address public pendingOwner;
    /// The only address that may submit spends. The backend's hot key: it can
    /// SUBMIT, and nothing else — it cannot change a policy, lift a band, or
    /// approve its own escalation.
    address public executor;
    address public keeper;
    /// Whose signature releases a parked spend. This contract does not care how
    /// that signature was gated — an owner key here, a World ID device flow
    /// elsewhere. The containment argument is the same either way: the key can
    /// only release a spend whose exact hash THIS CONTRACT opened, inside its
    /// TTL, once. It cannot invent a spend, change an amount, or reach past the
    /// frozen/band/cap checks.
    address public humanApprover;
    /// May write the fixed guest template and nothing else.
    address public guestRegistrar;
    /// The policy compiler's deploy key.
    address public studioDeployer;

    bool public paused;
    bool public requirePolicyCheckpoint;
    bytes32 public treasurerBinding;

    Policy public policy;
    ISleeve public working;
    ISleeve public reserve;
    uint256 public guestDailyCap;

    mapping(bytes32 => Agent) internal agents;
    mapping(bytes32 => mapping(address => bool)) public allowedSeller;
    /// Guests get a GLOBAL allowlist, not an empty one. An earlier draft let a
    /// guest pay any address whatsoever — including its own EOA, which would
    /// break the invariant that no receipt ever pays an agent.
    mapping(address => bool) public guestSeller;
    mapping(bytes32 => bool) public usedNonce;
    mapping(uint256 => Checkpoint) public checkpoints;

    uint256 public nextCheckpointId = 1;
    uint256 public receiptCount;

    uint256 private _lock = 1;

    event Receipt(
        uint256 indexed id,
        bytes32 indexed agentId,
        address indexed seller,
        bytes32 index,
        uint64 printId,
        uint256 units,
        uint256 quote,
        uint256 fair,
        int256 premiumBps,
        bool jitFunded,
        bool guest,
        bool humanApproved
    );
    event Denied(
        bytes32 indexed agentId,
        uint8 indexed code,
        string reason,
        uint256 quote,
        uint256 fair,
        bytes32 nonce
    );
    event CheckpointOpened(
        uint256 indexed id, bytes32 indexed agentId, bytes32 reqHash, uint8 kind, uint64 expiresAt
    );
    event CheckpointResolved(uint256 indexed id, uint8 indexed outcome, string reason);
    event PolicyUpdated(bytes32 configHash);
    event AgentUpdated(bytes32 indexed agentId, uint256 dailyCap, uint256 perRequest, bool frozen);
    event SellerAllowed(bytes32 indexed agentId, address indexed seller, bool allowed);
    event GuestSellerAllowed(address indexed seller, bool allowed);
    event GuestRegistered(bytes32 indexed agentId, uint256 dailyCap);
    event Rebalanced(bool intoSleeves, uint256 amount, uint256 targetBuffer);
    event Wired(address executor, address keeper, address approver, address registrar, address studio);
    event SleevesSet(address working, address reserve);
    event PausedSet(bool paused);
    event PolicyCheckpointRequired(bool required);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyExecutor() {
        require(msg.sender == executor, "not executor");
        _;
    }

    modifier ownerOrStudio() {
        require(msg.sender == owner || msg.sender == studioDeployer, "not owner or studio");
        _;
    }

    /// @dev Effects precede external calls everywhere in this contract, so this
    ///      guard is a belt to that brace rather than the only protection. Both,
    ///      because the external call here is into a yield venue we do not own.
    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address usdc_, address prices_, uint256 guestDailyCap_) {
        require(usdc_ != address(0) && prices_ != address(0), "zero arg");
        usdc = IERC20(usdc_);
        prices = IFloatPrices(prices_);
        guestDailyCap = guestDailyCap_;
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Float Vault")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // --- wiring --------------------------------------------------------------

    /// @notice Set the roles, once.
    /// @dev    ONE-SHOT on purpose. An earlier draft left this re-callable with a
    ///         comment claiming it was not, which would let the owner re-point
    ///         the sleeves at any contract and then have `rebalance` approve and
    ///         deposit the whole excess into it. Sleeves move through
    ///         `setSleeves`, which is owner-only and emits — so a venue change is
    ///         on the record rather than silent.
    function wire(
        address executor_,
        address keeper_,
        address approver_,
        address registrar_,
        address studio_,
        ISleeve working_,
        ISleeve reserve_
    ) external onlyOwner {
        require(executor == address(0), "already wired");
        require(executor_ != address(0), "zero executor");
        executor = executor_;
        keeper = keeper_;
        humanApprover = approver_;
        guestRegistrar = registrar_;
        studioDeployer = studio_;
        working = working_;
        reserve = reserve_;
        emit Wired(executor_, keeper_, approver_, registrar_, studio_);
        emit SleevesSet(address(working_), address(reserve_));
    }

    function setSleeves(ISleeve working_, ISleeve reserve_) external onlyOwner {
        working = working_;
        reserve = reserve_;
        emit SleevesSet(address(working_), address(reserve_));
    }

    function setApprover(address approver_) external onlyOwner {
        humanApprover = approver_;
    }

    /// @notice Bind approvals to one human identity, once.
    function setTreasurerBinding(bytes32 binding) external onlyOwner {
        require(treasurerBinding == bytes32(0), "binding set");
        treasurerBinding = binding;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
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

    /// @notice The owner can always retrieve their own money — same stance, and
    ///         same reason, as `PolicyWallet.withdraw`: a treasury its owner can
    ///         be locked out of by a rule they set is a reason not to run it.
    ///         Deliberately not budgeted, and deliberately not reachable by the
    ///         executor, the keeper or an agent.
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero to");
        require(amount > 0, "zero amount");
        require(usdc.transfer(to, amount), "transfer failed");
        emit Withdrawn(to, amount);
    }

    // --- governance ----------------------------------------------------------

    function setPolicyCheckpointRequired(bool required, uint256 cpId, uint8 v, bytes32 r, bytes32 s)
        external
        ownerOrStudio
    {
        // Turning the gate OFF once it is ON needs a human, or the gate is a
        // suggestion a compromised studio session could switch off first.
        if (!required && requirePolicyCheckpoint) {
            _consumePolicyApproval(cpId, keccak256("FLOAT_POLICY_GATE_OFF"), v, r, s);
        }
        requirePolicyCheckpoint = required;
        emit PolicyCheckpointRequired(required);
    }

    function setPolicy(
        Policy calldata p,
        bytes32 configHash,
        uint256 cpId,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external ownerOrStudio {
        require(p.maxPrintAge > 0, "zero print age");
        // An approval widens the band. A "human" band tighter than the agent's
        // own would mean escalating made the answer MORE restrictive, which is
        // not what parking a payment for a person is for.
        require(p.humanMaxPremiumBps >= p.maxPremiumBps, "human band below agent band");
        require(p.humanMaxPremiumBps <= 10_000, "human band above 100%");
        require(p.workingShareBps <= 10_000, "share above 100%");
        require(p.upperBandBps <= 10_000 && p.lowerBandBps <= 10_000, "band above 100%");
        if (requirePolicyCheckpoint) _consumePolicyApproval(cpId, configHash, v, r, s);
        policy = p;
        emit PolicyUpdated(configHash);
    }

    function setAgent(
        bytes32 agentId,
        uint256 dailyCapUsdc,
        uint256 perRequestUsdc,
        bool frozen,
        bytes32 configHash,
        uint256 cpId,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external ownerOrStudio {
        require(agentId != bytes32(0), "zero agent");
        require(dailyCapUsdc > 0 && perRequestUsdc > 0, "zero limit");
        // An unreachable threshold reads as a limit while enforcing nothing —
        // the same requirement `PolicyWallet.setBudget` makes of `perTxLimit`.
        require(perRequestUsdc <= dailyCapUsdc, "per-request above daily cap");
        if (requirePolicyCheckpoint) _consumePolicyApproval(cpId, configHash, v, r, s);

        Agent storage a = agents[agentId];
        a.dailyCapUsdc = dailyCapUsdc;
        a.perRequestUsdc = perRequestUsdc;
        a.frozen = frozen;
        if (!a.exists) {
            a.exists = true;
            a.periodLength = 1 days;
            a.periodStart = uint64(block.timestamp);
            a.spent = 0;
        }
        emit AgentUpdated(agentId, dailyCapUsdc, perRequestUsdc, frozen);
    }

    /// @dev Gated by the policy checkpoint too when the gate is on. The seller
    ///      allowlist is the check the overcharge demo rests on, so widening it
    ///      must not be the one governance action that stays ungated.
    function allowSeller(
        bytes32 agentId,
        address seller,
        bool allowed,
        uint256 cpId,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external ownerOrStudio {
        require(seller != address(0), "zero seller");
        if (requirePolicyCheckpoint) {
            _consumePolicyApproval(
                cpId, keccak256(abi.encode("FLOAT_ALLOW_SELLER", agentId, seller, allowed)), v, r, s
            );
        }
        allowedSeller[agentId][seller] = allowed;
        emit SellerAllowed(agentId, seller, allowed);
    }

    function allowGuestSeller(address seller, bool allowed) external onlyOwner {
        require(seller != address(0), "zero seller");
        guestSeller[seller] = allowed;
        emit GuestSellerAllowed(seller, allowed);
    }

    /// @notice Register a visitor's agent on the fixed guest template.
    /// @dev    The registrar role can do THIS and nothing else: it cannot touch
    ///         the policy, cannot reach an existing agent, and cannot choose the
    ///         numbers. That containment is the point — the thing wired to a
    ///         public join flow is the least powerful role in the contract.
    function registerGuest(bytes32 agentId) external {
        require(msg.sender == guestRegistrar, "not registrar");
        require(agentId != bytes32(0), "zero agent");
        require(!agents[agentId].exists, "agent exists");
        Agent storage a = agents[agentId];
        a.dailyCapUsdc = guestDailyCap;
        a.perRequestUsdc = guestDailyCap;
        a.periodLength = 1 days;
        a.periodStart = uint64(block.timestamp);
        a.guest = true;
        a.exists = true;
        emit GuestRegistered(agentId, guestDailyCap);
    }

    // --- views ---------------------------------------------------------------

    /// @dev Whole periods only, copied from `PolicyWallet._rolled` — and keyed
    ///      PER AGENT, which is the fix for a bug worth naming. A single global
    ///      day-start with a per-agent `spent` zeroes only the agent that
    ///      happens to spend first after a roll; every other agent keeps
    ///      yesterday's total against a window that has already moved, so their
    ///      daily cap shrinks permanently. And rolling to `block.timestamp`
    ///      rather than a whole-period boundary drifts the day forward by
    ///      however long the treasury sat idle.
    function _rolled(Agent memory a) internal view returns (uint256 spent, uint64 periodStart) {
        if (!a.exists || a.periodLength == 0) return (a.spent, a.periodStart);
        if (block.timestamp < uint256(a.periodStart) + a.periodLength) {
            return (a.spent, a.periodStart);
        }
        uint64 elapsed = uint64(block.timestamp) - a.periodStart;
        uint64 periods = elapsed / a.periodLength;
        return (0, a.periodStart + periods * a.periodLength);
    }

    function agentOf(bytes32 agentId)
        external
        view
        returns (
            bool exists,
            uint256 dailyCapUsdc,
            uint256 spent,
            uint256 perRequestUsdc,
            uint64 periodStart,
            bool frozen,
            bool guest
        )
    {
        Agent memory a = agents[agentId];
        (uint256 s, uint64 ps) = _rolled(a);
        return (a.exists, a.dailyCapUsdc, s, a.perRequestUsdc, ps, a.frozen, a.guest);
    }

    function remaining(bytes32 agentId) external view returns (uint256) {
        Agent memory a = agents[agentId];
        if (!a.exists) return 0;
        (uint256 s,) = _rolled(a);
        return s >= a.dailyCapUsdc ? 0 : a.dailyCapUsdc - s;
    }

    /// @notice Total value the treasury controls: buffer plus both sleeves.
    function totalValueUsdc() external view returns (uint256) {
        uint256 total = usdc.balanceOf(address(this));
        if (address(working) != address(0)) total += working.valueUsdc();
        if (address(reserve) != address(0)) total += reserve.valueUsdc();
        return total;
    }

    function hashSpendReq(SpendReq calldata r) public pure returns (bytes32) {
        return keccak256(abi.encode(r));
    }

    /// @notice The digest the human's key signs. Exposed so a signer checks
    ///         itself against the chain's arithmetic rather than a copy of it.
    function approvalDigest(uint256 id, bytes32 reqHash, uint64 expiresAt, bytes32 binding)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(APPROVAL_TYPEHASH, id, reqHash, expiresAt, binding));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Dry-run the ladder. Same function the spend path uses, so a
    ///         caller can ask "would this be refused, and why" without a
    ///         transaction and get the chain's real answer.
    function classify(SpendReq calldata r)
        external
        view
        returns (string memory reason, uint8 code, uint256 fairUsdc, uint64 printId)
    {
        return _check(r, policy.maxPremiumBps);
    }

    // --- the ladder ----------------------------------------------------------

    /// @dev Ordered cheapest-and-most-fundamental first, and every rung returns
    ///      its own sentence. `fairUsdc` and `printId` come back even on the
    ///      refusals that computed them, so `Denied` can carry the fair
    ///      counter-price — "here is what this should have cost" is the whole
    ///      value of refusing an overcharge rather than merely blocking it.
    function _check(SpendReq calldata r, uint16 band)
        internal
        view
        returns (string memory, uint8, uint256, uint64)
    {
        if (paused) return ("treasury paused", D_PAUSED, 0, 0);

        Agent memory a = agents[r.agentId];
        if (!a.exists) return ("unknown agent", D_UNKNOWN_AGENT, 0, 0);
        if (a.frozen) return ("agent frozen by policy", D_FROZEN, 0, 0);

        bool sellerOk =
            a.guest ? guestSeller[r.seller] : allowedSeller[r.agentId][r.seller];
        if (r.seller == address(0) || !sellerOk) return ("seller not allowed", D_SELLER, 0, 0);

        if (r.nonce == bytes32(0) || usedNonce[r.nonce]) {
            return ("replayed request", D_REPLAY, 0, 0);
        }
        if (r.units == 0 || r.units > MAX_UNITS || r.quoteTotal == 0) {
            return ("absurd units", D_UNITS, 0, 0);
        }

        (uint256 priceWad, uint64 pid, uint64 postedAt,) = prices.latest(r.index);
        if (pid == 0) return ("no print for index", D_NO_PRINT, 0, 0);
        // Bound on postedAt, which is CHAIN time. A signer-supplied economic
        // clock may lead block time, and comparing against it would underflow.
        if (postedAt > block.timestamp || block.timestamp - postedAt > policy.maxPrintAge) {
            return ("stale ACR print", D_STALE, 0, pid);
        }
        if (pid != r.printId) return ("print changed; re-quote", D_ROTATED, 0, pid);

        // The one conversion. See the UNITS block at the top of this contract.
        uint256 fair = (priceWad * r.units) / WAD_TO_USDC;
        // A fair total that rounds to zero cannot be banded against, and would
        // panic the premium division below. A price this small means the index's
        // bundle size is wrong, which is a keeper bug, not a spend to allow.
        if (fair == 0) return ("no print for index", D_NO_PRINT, 0, pid);

        if (r.quoteTotal > (fair * (10_000 + uint256(band))) / 10_000) {
            return ("quote exceeds ACR fair band", D_BAND, fair, pid);
        }
        // Strictly below is the agent's own authority — the convention
        // `PolicyWallet.spend` documents, kept identical here on purpose.
        if (r.quoteTotal >= a.perRequestUsdc) {
            return ("over per-request threshold", D_PER_REQUEST, fair, pid);
        }
        (uint256 spent,) = _rolled(a);
        if (spent + r.quoteTotal > a.dailyCapUsdc) {
            return ("daily cap exceeded", D_DAILY_CAP, fair, pid);
        }
        return ("", 0, fair, pid);
    }

    // --- the automatic path --------------------------------------------------

    /// @notice The hero loop. Returns false on a refusal rather than reverting,
    ///         so the `Denied` log survives for anyone to read.
    function requestSpend(SpendReq calldata r)
        external
        onlyExecutor
        nonReentrant
        returns (bool ok, uint256 id)
    {
        (string memory reason, uint8 code, uint256 fair, uint64 pid) =
            _check(r, policy.maxPremiumBps);
        if (code != 0) {
            // Burn the nonce even on refusal: a request that was refused must
            // not become payable later because a cap rolled or a price moved.
            // The agent retries with a fresh request, which is re-priced.
            if (r.nonce != bytes32(0)) usedNonce[r.nonce] = true;
            emit Denied(r.agentId, code, reason, r.quoteTotal, fair, r.nonce);
            return (false, 0);
        }
        return (true, _spend(r, fair, pid, false));
    }

    function _spend(SpendReq calldata r, uint256 fairUsdc, uint64 printId, bool human)
        internal
        returns (uint256 id)
    {
        Agent storage a = agents[r.agentId];

        // EFFECTS FIRST, before any call leaves this contract. The sleeve pull
        // below is a call into a yield venue we do not own; bumping `spent`
        // after it would let a hostile sleeve re-enter with a fresh nonce and
        // spend the daily cap twice. `PolicyWallet._spend` makes the same
        // ordering choice for the same reason.
        usedNonce[r.nonce] = true;
        (uint256 spent, uint64 periodStart) = _rolled(a);
        a.spent = spent + r.quoteTotal;
        a.periodStart = periodStart;

        bool jit = _fund(r.quoteTotal);

        // MEASURE, DO NOT ASSUME. A share-priced sleeve can deliver less than
        // asked. Without this the shortfall surfaces as "transfer failed" after
        // the yield position was already unwound, which reads as a token bug
        // and is not one.
        require(usdc.balanceOf(address(this)) >= r.quoteTotal, "sleeve delivered short");
        require(usdc.transfer(r.seller, r.quoteTotal), "transfer failed");

        id = ++receiptCount;
        emit Receipt(
            id,
            r.agentId,
            r.seller,
            r.index,
            printId,
            r.units,
            r.quoteTotal,
            fairUsdc,
            (int256(r.quoteTotal) - int256(fairUsdc)) * 10_000 / int256(fairUsdc),
            jit,
            a.guest,
            human
        );
    }

    /// @dev Working sleeve first, reserve second, and the second pull is sized
    ///      from the MEASURED balance rather than from what the first pull was
    ///      asked for.
    function _fund(uint256 need) internal returns (bool jit) {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal >= need) return false;

        uint256 shortfall = need - bal;
        if (address(working) != address(0)) {
            uint256 w = working.valueUsdc();
            uint256 fromWorking = shortfall > w ? w : shortfall;
            if (fromWorking > 0) working.withdrawExact(fromWorking);
        }
        uint256 held = usdc.balanceOf(address(this));
        if (held < need && address(reserve) != address(0)) {
            reserve.withdrawExact(need - held);
        }
        return true;
    }

    // --- the human path ------------------------------------------------------

    function openCheckpoint(bytes32 agentId, bytes32 reqHash, uint8 kind, uint64 ttl)
        external
        onlyExecutor
        returns (uint256 id)
    {
        require(reqHash != bytes32(0), "zero hash");
        require(kind == KIND_SPEND || kind == KIND_POLICY, "bad kind");
        require(ttl > 0, "zero ttl");
        id = nextCheckpointId++;
        uint64 expiresAt = uint64(block.timestamp) + ttl;
        checkpoints[id] = Checkpoint(reqHash, expiresAt, kind, OPEN);
        emit CheckpointOpened(id, agentId, reqHash, kind, expiresAt);
    }

    /// @notice Record a denial, a timeout, or a failed verification on chain.
    /// @dev    An unsuccessful escalation is evidence, not silence. Nothing moves
    ///         and the reason is public.
    function resolveCheckpoint(uint256 id, uint8 outcome, string calldata reason)
        external
        onlyExecutor
    {
        Checkpoint storage c = checkpoints[id];
        require(c.status == OPEN, "checkpoint closed");
        require(outcome >= DENIED && outcome <= FAILED, "bad outcome");
        c.status = outcome;
        emit CheckpointResolved(id, outcome, reason);
    }

    /// @notice Release a parked spend against the human's single-use signature.
    /// @dev    Reverts on a failed re-check rather than emitting `Denied`: the
    ///         whole transaction must roll back so the checkpoint stays open for
    ///         a retry inside its TTL, and the backend already has the reason.
    function executeApproved(uint256 id, SpendReq calldata r, uint8 v, bytes32 rs, bytes32 ss)
        external
        onlyExecutor
        nonReentrant
        returns (uint256)
    {
        _consumeApproval(id, hashSpendReq(r), KIND_SPEND, v, rs, ss);
        (string memory reason, uint8 code, uint256 fair, uint64 pid) =
            _check(r, policy.humanMaxPremiumBps);
        require(code == 0, reason);
        uint256 receiptId = _spend(r, fair, pid, true);
        emit CheckpointResolved(id, CONSUMED, "approved");
        return receiptId;
    }

    function _consumeApproval(
        uint256 id,
        bytes32 reqHash,
        uint8 kind,
        uint8 v,
        bytes32 rs,
        bytes32 ss
    ) internal {
        Checkpoint storage c = checkpoints[id];
        require(c.status == OPEN, "checkpoint closed");
        require(c.kind == kind, "wrong checkpoint kind");
        require(block.timestamp < c.expiresAt, "checkpoint expired");
        require(c.reqHash == reqHash, "request changed");
        // `ecrecover` returns the zero address on a malformed signature, so an
        // unset approver would make every piece of garbage a valid approval.
        require(humanApprover != address(0), "no approver");
        address signer = ecrecover(approvalDigest(id, reqHash, c.expiresAt, treasurerBinding), v, rs, ss);
        require(signer != address(0) && signer == humanApprover, "bad approval");
        // Consumed BEFORE any effect, so a re-entrant call finds it spent.
        c.status = CONSUMED;
    }

    function _consumePolicyApproval(uint256 id, bytes32 cfgHash, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        _consumeApproval(id, cfgHash, KIND_POLICY, v, r, s);
        emit CheckpointResolved(id, CONSUMED, "policy approved");
    }

    // --- the keeper ----------------------------------------------------------

    /// @notice Move float between the buffer and the sleeves, within bands.
    /// @dev    Does nothing inside the bands, and nothing below `minTicketUsdc`,
    ///         because a rebalance that costs more in fees than it earns is a
    ///         loss dressed as activity.
    function rebalance(uint256 targetBuffer) external nonReentrant {
        require(msg.sender == keeper, "not keeper");
        require(!paused, "treasury paused");

        uint256 bal = usdc.balanceOf(address(this));
        uint256 hi = targetBuffer * (10_000 + uint256(policy.upperBandBps)) / 10_000;
        uint256 lo = targetBuffer * (10_000 - uint256(policy.lowerBandBps)) / 10_000;

        if (bal > hi && bal - targetBuffer >= policy.minTicketUsdc) {
            uint256 excess = bal - targetBuffer;
            uint256 toWorking = excess * uint256(policy.workingShareBps) / 10_000;
            uint256 toReserve = excess - toWorking;
            if (toWorking > 0 && address(working) != address(0)) {
                require(usdc.approve(address(working), toWorking), "approve failed");
                working.depositIdle(toWorking);
            }
            if (toReserve > 0 && address(reserve) != address(0)) {
                require(usdc.approve(address(reserve), toReserve), "approve failed");
                reserve.depositIdle(toReserve);
            }
            emit Rebalanced(true, excess, targetBuffer);
        } else if (bal < lo && targetBuffer - bal >= policy.minTicketUsdc) {
            uint256 need = targetBuffer - bal;
            _fund(targetBuffer);
            emit Rebalanced(false, need, targetBuffer);
        }
    }
}
