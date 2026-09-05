"""acr_oracle_client — sign + post ACR prints on-chain."""

from __future__ import annotations

from .client import (
    ORACLE_ABI,
    OracleClient,
    PostPayload,
    index_id_to_bytes32,
    to_usdc,
    to_wad,
)
from .futures import (
    FUTURES_ABI,
    FuturesClient,
    bytes32_to_index_id,
    descale_position,
    descale_series,
    select_series_for_index,
)
from .mirror import (
    MIRROR_ABI,
    MirrorClient,
    settlement_id,
    to_bytes32,
)
from .registry import (
    REGISTRY_ABI,
    RegistryClient,
    bytes32_to_schema,
    schema_to_bytes32,
)
from .signer import (
    CircleWalletSigner,
    LocalKeySigner,
    Signer,
    build_role_signer,
    build_signer,
    full_eip712_json,
    split_signature,
)

__all__ = [
    "OracleClient",
    "PostPayload",
    "ORACLE_ABI",
    "index_id_to_bytes32",
    "to_wad",
    "to_usdc",
    "RegistryClient",
    "REGISTRY_ABI",
    "schema_to_bytes32",
    "bytes32_to_schema",
    "MirrorClient",
    "MIRROR_ABI",
    "settlement_id",
    "to_bytes32",
    "FuturesClient",
    "FUTURES_ABI",
    "bytes32_to_index_id",
    "descale_series",
    "descale_position",
    "select_series_for_index",
    "Signer",
    "LocalKeySigner",
    "CircleWalletSigner",
    "build_signer",
    "build_role_signer",
    "split_signature",
    "full_eip712_json",
]

__version__ = "0.1.0"
