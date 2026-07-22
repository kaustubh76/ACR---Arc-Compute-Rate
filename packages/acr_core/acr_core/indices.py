"""The ACR index family.

Every economy gets a spot market first and a reference rate second. ACR is the
rate layer for machine commerce. Three inaugural indices, one per service class
of the agentic economy.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Service(str, Enum):
    """The three service classes ACR indexes."""

    INFERENCE = "inference"
    GPU = "gpu"
    DATA = "data"


@dataclass(frozen=True)
class IndexSpec:
    """Definition of a single ACR index."""

    id: str
    service: Service
    unit: str
    description: str
    #: Nominal reference level ($ per unit) used to seed simulation / sanity checks.
    reference_level: float


INDEX_REGISTRY: dict[str, IndexSpec] = {
    "ACR-INF": IndexSpec(
        id="ACR-INF",
        service=Service.INFERENCE,
        unit="$/1k tokens",
        description="Constant-quality price of one thousand inference tokens.",
        reference_level=0.50,
    ),
    "ACR-GPU": IndexSpec(
        id="ACR-GPU",
        service=Service.GPU,
        unit="$/GPU-sec",
        description="Constant-quality price of one GPU-second of compute.",
        reference_level=0.011,
    ),
    "ACR-DATA": IndexSpec(
        id="ACR-DATA",
        service=Service.DATA,
        unit="$/MB",
        description="Constant-quality price of one megabyte of served data.",
        reference_level=0.002,
    ),
}

ALL_INDEX_IDS: tuple[str, ...] = tuple(INDEX_REGISTRY.keys())


def spec_for(index_id: str) -> IndexSpec:
    try:
        return INDEX_REGISTRY[index_id]
    except KeyError as exc:  # pragma: no cover - defensive
        raise KeyError(
            f"unknown index {index_id!r}; known: {list(INDEX_REGISTRY)}"
        ) from exc


def index_for_service(service: Service) -> IndexSpec:
    for spec in INDEX_REGISTRY.values():
        if spec.service == service:
            return spec
    raise KeyError(f"no index for service {service!r}")  # pragma: no cover
