"""Deterministic demo seller identities for testnet — shared by the attestation
writer (``scripts/attest_once.py``) and the tape-seeder (``scripts/seed_sellers.py``).

Each seller is an ephemeral EOA derived from a label (testnet identities only,
never funds worth protecting). Sharing the set here guarantees the addresses that
get **attested** on-chain are exactly the ones seeded into the tape, so the
estimator's hedonic stage reads real on-chain attestation metadata for real tape
sellers.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from acr_core import ModelClass, Service

from .signer import LocalKeySigner


@dataclass(frozen=True)
class DemoSeller:
    label: str
    service: Service
    model_class: ModelClass
    latency_slo_ms: int
    schema_id: str

    @property
    def private_key(self) -> str:
        """Deterministic ephemeral key from the label (testnet only)."""
        return "0x" + hashlib.sha256(f"acr-attest::{self.label}".encode()).hexdigest()

    def signer(self) -> LocalKeySigner:
        return LocalKeySigner(self.private_key)

    @property
    def address(self) -> str:
        return self.signer().address


#: One seller per (service × class) mix so the catalog/hedonic see a spread.
DEMO_SELLERS: list[DemoSeller] = [
    DemoSeller("acr-seller-inf-frontier", Service.INFERENCE, ModelClass.FRONTIER, 800, "openai/chat@1"),
    DemoSeller("acr-seller-inf-open", Service.INFERENCE, ModelClass.OPEN, 1200, "llama/chat@1"),
    DemoSeller("acr-seller-gpu-mid", Service.GPU, ModelClass.MID, 2500, "gpu/h100@1"),
    DemoSeller("acr-seller-data-small", Service.DATA, ModelClass.SMALL, 400, "data/feed@1"),
]
