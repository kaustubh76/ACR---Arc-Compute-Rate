// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title HumanIdMirror — a verified human, grouped without being named.
/// @notice The manipulation bound ACR publishes is denominated in wallets. A
///         wallet costs a funding transfer; a World ID costs a human being. To
///         price an attack in humans instead, the tape has to know which wallets
///         act for ONE human — and it has to learn that without publishing who
///         that human is.
///
///         WHAT IS NOT HERE: the World ID nullifier. Writing `wallet -> nullifier`
///         would put a durable, cross-service identifier against every wallet in
///         a person's fleet, permanently, on a public chain. What is written
///         instead is a WINDOW-ROTATED CLUSTER ID, computed off-chain:
///
///             clusterId = keccak256(abi.encode(nullifier, SERVICE_SALT, window))
///
///         Within one window the id groups a human's wallets, which is all the
///         cleaning stack needs to cap them together and all the tape needs to
///         count distinct humans. Across windows the id changes, so the durable
///         nullifier never appears ON ARC and nobody can join this tape to
///         another service's data keyed by the same World ID.
///
///         BE PRECISE ABOUT WHAT THAT BUYS. Rotation does NOT unlink a fleet:
///         wallets are the join key and they do not rotate, so a wallet seen
///         under two windows' ids chains them together. What rotation prevents
///         is CROSS-SERVICE correlation, not within-tape grouping.
///
///         AND IT IS NARROWER STILL THAN THAT. World's own AgentBook publishes
///         `wallet -> nullifier` on World Chain, so a registered fleet is
///         ALREADY public there to anyone reading `AgentRegistered`. Nothing
///         here could change that, and nothing here should be read as claiming
///         to. What this contract does is keep ACR's tape from becoming a
///         SECOND publication of that durable identifier, keyed to our own
///         settlement data. We neither add to AgentBook's disclosure nor depend
///         on it having been private. Hiding the
///         grouping itself would need aggregate-only publication or a ZK proof
///         of cap compliance; neither is here, and the README says so rather
///         than implying otherwise.
///
///         WHAT IS ALSO HERE: whether the human is a World ID Sandbox identity
///         or an Orb-verified one, as `sandbox` on the event and
///         `clusterProvenance` on chain. Demo identities are not people, and a
///         benchmark that counted them silently would be claiming security it
///         does not have. Same reason `Settlement.synthetic` is on the tape
///         rather than in a config file: disclosed, queryable, discountable by a
///         reader who never has to trust the operator.
///
///         The resolver knows the nullifier and could publish it. That places
///         this alongside the tape's other keeper-authored, trust-required
///         facts — stated, not hidden. `SALT_COMMITMENT` narrows it: the salt is
///         never revealed, but committing to it at deploy stops the resolver
///         retroactively picking salts to manufacture whichever grouping
///         flatters a number.
///
/// @dev    Mirrors `ReceiptMirror` and `FeedAccessAttestor` on purpose — same
///         domain separator construction, same public digest view, same
///         `isSigner` authorization, same two-step ownership, same permissionless
///         relay — so one reviewer's understanding covers all three. Like them
///         it has no pause: a mirror that stops recording does not protect
///         anything, it just makes the tape wrong more quietly.
contract HumanIdMirror {
    // Units and shapes, once, so nothing downstream has to guess:
    //   wallet     the payer address a settlement is signed from.
    //   clusterId  bytes32, computed OFF-CHAIN. The contract cannot check how it
    //              was derived — it is an opaque grouping key, and that opacity
    //              is the point. What the contract CAN enforce is that one
    //              wallet holds one cluster per window, which is the property
    //              the cap depends on.
    //   window     floor(blockTime / RATING_WINDOW). Not a timestamp.

    bytes32 public constant RESOLUTION_TYPEHASH =
        keccak256("HumanCluster(address wallet,bytes32 clusterId,uint64 window,bool sandbox)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice The rotation period, and deliberately the SAME span the seller
    ///         rating is computed over. Distinct-cluster-count then equals
    ///         distinct-human-count exactly, over precisely the window a grade
    ///         already uses. A shorter rotation (hourly, matching prints) would
    ///         give one human up to 168 ids a week and overcount humans by that
    ///         factor — more rotation is more privacy theatre, not more privacy,
    ///         because of the fleet-linkage note above.
    uint64 public constant RATING_WINDOW = 7 days;

    /// @notice keccak256 of the off-chain salt. Never the salt itself: publishing
    ///         it would let anyone holding a nullifier confirm fleet membership
    ///         by recomputation, which is the one thing rotation is protecting.
    bytes32 public immutable SALT_COMMITMENT;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isSigner;

    /// @notice wallet => window => clusterId. Zero means "not resolved", which
    ///         is a different fact from "resolved as not human" — the tape has
    ///         no way to express the latter and does not pretend to.
    mapping(address => mapping(uint64 => bytes32)) public clusterOf;

    uint8 internal constant PROVENANCE_UNSET = 0;
    uint8 internal constant PROVENANCE_REAL = 1;
    uint8 internal constant PROVENANCE_SANDBOX = 2;

    /// @notice Whether a cluster stands for a Sandbox identity or an
    ///         Orb-verified one. Disclosed on chain for the same reason
    ///         `Settlement.synthetic` is: a reader should be able to discount
    ///         demo provenance from the tape itself rather than by trusting a
    ///         config file they cannot see. Provenance is a property of the
    ///         human, not of any one wallet, so it may never flip — see
    ///         `record`.
    mapping(bytes32 => uint8) public clusterProvenance;

    /// @dev The resolver is emitted rather than left implicit: "was this
    ///      resolver authorized when it signed" is answerable from the tape
    ///      only if the tape records who signed, which is the same argument
    ///      `SignerChange` exists for.
    event HumanClusterResolved(
        bytes32 indexed clusterId,
        address indexed wallet,
        uint64 indexed window,
        bool sandbox,
        address resolver
    );

    /// @dev A rebind is a governance action, not a resolution, so it carries the
    ///      owner rather than a resolver and names both sides. It exists to be
    ///      rare and visible: see `ownerRebind`.
    event HumanClusterRebound(
        address indexed wallet, uint64 indexed window, bytes32 from, bytes32 to, address owner
    );

    event SignerSet(address indexed signer, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(bytes32 saltCommitment) {
        require(saltCommitment != bytes32(0), "zero salt commitment");
        SALT_COMMITMENT = saltCommitment;
        owner = msg.sender;
        isSigner[msg.sender] = true;
        emit SignerSet(msg.sender, true);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Human Id Mirror")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // --- admin ---

    function setSigner(address signer, bool allowed) external onlyOwner {
        isSigner[signer] = allowed;
        emit SignerSet(signer, allowed);
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

    // --- reads ---

    /// @notice The window `blockTime` falls in. Exposed so an off-chain resolver
    ///         computes the window from the chain's arithmetic rather than a
    ///         reimplementation of it — the same reason the digest views exist.
    function windowOf(uint64 blockTime) public pure returns (uint64) {
        return blockTime / RATING_WINDOW;
    }

    function currentWindow() public view returns (uint64) {
        return uint64(block.timestamp) / RATING_WINDOW;
    }

    /// @notice The EIP-712 digest a resolver signs.
    function resolutionDigest(address wallet, bytes32 clusterId, uint64 window, bool sandbox)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(RESOLUTION_TYPEHASH, wallet, clusterId, window, sandbox));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice This wallet's cluster for the window in progress, or zero.
    function currentCluster(address wallet) external view returns (bytes32) {
        return clusterOf[wallet][currentWindow()];
    }

    /// @notice Whether `wallet` is currently backed by a verified human — the
    ///         single call another contract needs to weight, cap, or gate on it.
    function isHumanBacked(address wallet) external view returns (bool) {
        return clusterOf[wallet][currentWindow()] != bytes32(0);
    }

    /// @notice Whether this cluster stands for a Sandbox identity rather than an
    ///         Orb-verified human. False for an unresolved cluster too — callers
    ///         that need the distinction should read `clusterProvenance`.
    function isSandboxCluster(bytes32 clusterId) external view returns (bool) {
        return clusterProvenance[clusterId] == PROVENANCE_SANDBOX;
    }

    // --- resolution ---

    /// @notice Record that `wallet` belongs to `clusterId` for `window`.
    ///         Permissionless relay: the authenticity is in the signature, not
    ///         in `msg.sender`, so the resolver can post its own resolutions or
    ///         a relayer can do it for them.
    ///
    ///         Idempotent. Re-recording an identical resolution returns without
    ///         writing and without reverting, because the resolver is a loop
    ///         that reruns — `make resolve-humans` is expected to be safe to run
    ///         twice, and a revert would make "already correct" indistinguishable
    ///         from "failed".
    ///
    ///         Recording a DIFFERENT cluster for a wallet already resolved in
    ///         this window reverts. That is the point of the contract: without
    ///         it a farm could churn one wallet through many clusters inside a
    ///         window and buy back exactly the sybil headroom the human cap
    ///         removes. Correcting a genuine mistake is `ownerRebind`, which is
    ///         loud.
    ///
    ///         `window` must be the window in progress. A future window would
    ///         let a resolver pre-commit groupings before the flow they describe
    ///         exists; a past one would let it rewrite a window the tape has
    ///         already counted. A transaction that straddles a boundary reverts
    ///         and the resolver retries — which is safe precisely because the
    ///         call is idempotent.
    ///
    ///         No nonce. A replayed signature is either the idempotent no-op
    ///         above or hits the rebind guard, and the window it names stops
    ///         being current within one period. The same reasoning ACROracle
    ///         uses to omit one.
    function record(
        address wallet,
        bytes32 clusterId,
        uint64 window,
        bool sandbox,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(wallet != address(0), "zero wallet");
        require(clusterId != bytes32(0), "zero cluster");
        require(window == currentWindow(), "not the current window");

        bytes32 digest = resolutionDigest(wallet, clusterId, window, sandbox);
        address resolver = ecrecover(digest, v, r, s);
        require(resolver != address(0) && isSigner[resolver], "bad signer");

        // Provenance belongs to the human, not to any one of their wallets, so
        // it must agree across every wallet in the cluster AND across every
        // re-record. Checked BEFORE the idempotent return below, because a
        // repeat that claims the opposite provenance is not a repeat — it is an
        // attempt to launder a demo identity into a verified one, which would
        // move a published number without moving anything real.
        uint8 want = sandbox ? PROVENANCE_SANDBOX : PROVENANCE_REAL;
        uint8 have = clusterProvenance[clusterId];
        if (have == PROVENANCE_UNSET) {
            clusterProvenance[clusterId] = want;
        } else {
            require(have == want, "provenance mismatch");
        }

        bytes32 existing = clusterOf[wallet][window];
        if (existing == clusterId) return; // idempotent: already recorded
        require(existing == bytes32(0), "already clustered");

        clusterOf[wallet][window] = clusterId;
        emit HumanClusterResolved(clusterId, wallet, window, sandbox, resolver);
    }

    /// @notice Move a wallet to a different cluster inside a window it is
    ///         already resolved in. Owner-only and separate from `record` on
    ///         purpose: a resolver key that could rebind at will would defeat
    ///         the cap it exists to enforce, so the ability to say "that
    ///         grouping was wrong" sits with the two-step owner and emits its
    ///         own event rather than hiding inside a resolution.
    ///
    ///         Also the only way to clear a resolution, by rebinding to zero.
    function ownerRebind(address wallet, uint64 window, bytes32 clusterId) external onlyOwner {
        require(wallet != address(0), "zero wallet");
        // Only into a cluster that has actually been recorded, or to zero to
        // clear. A rebind carries no provenance of its own, so allowing an
        // unknown target would mint a cluster whose Sandbox-or-Orb status
        // nothing ever established — and the tape would have to guess, which on
        // this subject means claiming more than it knows.
        require(
            clusterId == bytes32(0) || clusterProvenance[clusterId] != PROVENANCE_UNSET,
            "unknown target cluster"
        );
        bytes32 existing = clusterOf[wallet][window];
        require(existing != clusterId, "no change");

        clusterOf[wallet][window] = clusterId;
        emit HumanClusterRebound(wallet, window, existing, clusterId, msg.sender);
    }
}
