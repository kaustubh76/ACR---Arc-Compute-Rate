// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AttestationRegistry
/// @notice Sellers attest EIP-712 signed service metadata (model class, latency
///         SLO, schema). This is the feature matrix Pillar 2's hedonic
///         regression reads. The flywheel: attest better metadata -> fairer
///         index placement -> more buyer flow -> sellers volunteer to feed the
///         matrix. The moat is econometric, not marketing.
contract AttestationRegistry {
    struct Attestation {
        address seller;
        uint8 service; // 0=inference, 1=gpu, 2=data
        uint8 modelClass; // 0=frontier,1=mid,2=small,3=open
        uint32 latencySloMs;
        bytes32 schemaId;
        uint64 timestamp;
        bool exists;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address seller,uint8 service,uint8 modelClass,uint32 latencySloMs,bytes32 schemaId,uint256 nonce,uint64 deadline)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => Attestation) private _attestations;
    address[] private _sellers;
    /// @notice Per-seller signature nonce — consumed on each `attestWithSig` so
    ///         a captured signature cannot be replayed.
    mapping(address => uint256) public nonces;

    event Attested(
        address indexed seller,
        uint8 indexed service,
        uint8 modelClass,
        uint32 latencySloMs,
        bytes32 schemaId,
        uint64 timestamp
    );

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ACR AttestationRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Attest your own metadata (msg.sender is the seller).
    function attest(
        uint8 service,
        uint8 modelClass,
        uint32 latencySloMs,
        bytes32 schemaId
    ) external {
        _store(msg.sender, service, modelClass, latencySloMs, schemaId);
    }

    /// @notice Attest on behalf of a seller via their EIP-712 signature.
    /// @dev    Replay-protected: the signature commits to the seller's current
    ///         `nonce` (consumed here) and a `deadline`. A captured signature
    ///         can neither be resubmitted (nonce advances) nor held indefinitely
    ///         to later revert a newer self-attestation (deadline expires).
    function attestWithSig(
        address seller,
        uint8 service,
        uint8 modelClass,
        uint32 latencySloMs,
        bytes32 schemaId,
        uint64 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = _attestDigest(
            seller, service, modelClass, latencySloMs, schemaId, nonces[seller]++, deadline
        );
        address recovered = ecrecover(digest, v, r, s);
        require(recovered == seller && recovered != address(0), "bad signature");
        _store(seller, service, modelClass, latencySloMs, schemaId);
    }

    function _attestDigest(
        address seller,
        uint8 service,
        uint8 modelClass,
        uint32 latencySloMs,
        bytes32 schemaId,
        uint256 nonce,
        uint64 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                seller,
                service,
                modelClass,
                latencySloMs,
                schemaId,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _store(
        address seller,
        uint8 service,
        uint8 modelClass,
        uint32 latencySloMs,
        bytes32 schemaId
    ) internal {
        require(service <= 2, "bad service");
        require(modelClass <= 3, "bad class");
        require(latencySloMs > 0, "bad latency");
        if (!_attestations[seller].exists) {
            _sellers.push(seller);
        }
        _attestations[seller] = Attestation({
            seller: seller,
            service: service,
            modelClass: modelClass,
            latencySloMs: latencySloMs,
            schemaId: schemaId,
            timestamp: uint64(block.timestamp),
            exists: true
        });
        emit Attested(seller, service, modelClass, latencySloMs, schemaId, uint64(block.timestamp));
    }

    function getAttestation(address seller) external view returns (Attestation memory) {
        return _attestations[seller];
    }

    function isAttested(address seller) external view returns (bool) {
        return _attestations[seller].exists;
    }

    function sellerCount() external view returns (uint256) {
        return _sellers.length;
    }

    function sellerAt(uint256 i) external view returns (address) {
        return _sellers[i];
    }
}
