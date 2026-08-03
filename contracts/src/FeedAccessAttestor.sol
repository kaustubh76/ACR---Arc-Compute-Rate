// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title FeedAccessAttestor — an off-chain x402 payment, made checkable on-chain.
/// @notice Circle Gateway settles x402 nanopayments off-chain and hands back a
///         batch UUID. Nothing on-chain can verify that: a contract cannot see
///         a Gateway settlement, so "this wallet paid for the feed" is a fact
///         that lives only in a seller's ledger. Asked directly, Circle's answer
///         was that you would need "an EIP-712 signed attestation or oracle
///         receipt to cryptographically verify the off-chain x402 payment
///         on-chain". This is that receipt.
///
///         The seller signs an EIP-712 `FeedAccess` struct with the same Circle
///         developer-controlled wallet that signs oracle prints, and anyone can
///         relay it here. The contract recovers the signer with `ecrecover` and
///         records `paidUntil[payer]` — so `hasFeedAccess(addr)` becomes a fact
///         any other contract can branch on. Off-chain revenue becomes an
///         on-chain right.
///
///         Deliberately its own contract rather than a change to ACRFutures:
///         the venue is live and holds real collateral, and a redeploy to add a
///         fee rebate would mean migrating open positions. Additive beats
///         risky. A venue that wants to rebate x402 payers reads this.
///
/// @dev    Mirrors ACROracle's idioms on purpose — same domain-separator
///         construction, same `isSigner` authorization, same two-step
///         ownership — so one reviewer's understanding covers both.
contract FeedAccessAttestor {
    // The signed struct, field by field:
    //   payer        the wallet that paid for the feed. NOT necessarily the
    //                account that trades: an x402 `exact` settlement is signed
    //                by an EOA (the facilitator `ecrecover`s EIP-3009), so a
    //                Circle agent wallet pays from its BACKING EOA while its
    //                smart account is what trades. `beneficiary` exists
    //                precisely so those two can differ.
    //   beneficiary  the account the access is granted to.
    //   paidUntil    access expires at this timestamp (seconds).
    //   amountUsdc   total settled, USDC 1e6-scaled — for auditability.
    //   nonce        replay guard; each nonce is redeemable once.
    bytes32 public constant FEED_ACCESS_TYPEHASH = keccak256(
        "FeedAccess(address payer,address beneficiary,uint64 paidUntil,uint256 amountUsdc,uint256 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice The furthest an attestation may reach into the future. A signer
    ///         compromise should cost weeks of free access, not a century of it.
    uint64 public constant MAX_ACCESS_WINDOW = 90 days;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isSigner;

    /// @notice When each beneficiary's feed access expires (0 = never had any).
    mapping(address => uint64) public paidUntil;
    /// @notice Cumulative attested spend per beneficiary, USDC 1e6-scaled.
    mapping(address => uint256) public totalPaidUsdc;
    mapping(uint256 => bool) public nonceUsed;

    event AccessGranted(
        address indexed beneficiary,
        address indexed payer,
        uint64 paidUntil,
        uint256 amountUsdc,
        uint256 nonce
    );
    event SignerSet(address indexed signer, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        isSigner[msg.sender] = true;
        emit SignerSet(msg.sender, true);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR Feed Access")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

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

    /// @notice The EIP-712 digest a seller signs. Exposed so an off-chain
    ///         signer can be checked against the chain's own arithmetic rather
    ///         than a reimplementation of it.
    function accessDigest(
        address payer,
        address beneficiary,
        uint64 paidUntilTs,
        uint256 amountUsdc,
        uint256 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                FEED_ACCESS_TYPEHASH, payer, beneficiary, paidUntilTs, amountUsdc, nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Redeem a signed attestation. Permissionless: the authenticity is
    ///         in the signature, not in `msg.sender`, so an agent can redeem its
    ///         own receipt or a relayer can do it for them.
    function redeem(
        address payer,
        address beneficiary,
        uint64 paidUntilTs,
        uint256 amountUsdc,
        uint256 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(beneficiary != address(0), "zero beneficiary");
        require(paidUntilTs > block.timestamp, "already expired");
        require(paidUntilTs <= block.timestamp + MAX_ACCESS_WINDOW, "window too long");
        require(!nonceUsed[nonce], "nonce used");

        bytes32 digest = accessDigest(payer, beneficiary, paidUntilTs, amountUsdc, nonce);
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && isSigner[signer], "bad signer");

        nonceUsed[nonce] = true;
        // Extend, never shorten: redeeming an older receipt after a newer one
        // must not revoke access the beneficiary has already been granted.
        if (paidUntilTs > paidUntil[beneficiary]) {
            paidUntil[beneficiary] = paidUntilTs;
        }
        totalPaidUsdc[beneficiary] += amountUsdc;
        emit AccessGranted(beneficiary, payer, paidUntilTs, amountUsdc, nonce);
    }

    /// @notice Whether `who` currently holds paid access to the feed — the
    ///         single call another contract needs to gate a rebate or a
    ///         discount on having paid for the index.
    function hasFeedAccess(address who) external view returns (bool) {
        return paidUntil[who] > block.timestamp;
    }
}
