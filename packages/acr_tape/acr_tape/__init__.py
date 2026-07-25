"""acr_tape — TapeSource ingestion (SimSource + ArcSource + ReceiptSource)."""

from __future__ import annotations

from .arc_source import ArcSource
from .base import TapeSource
from .receipt_source import ReceiptSource
from .sim_source import SimSource

__all__ = ["TapeSource", "SimSource", "ArcSource", "ReceiptSource"]

__version__ = "0.1.0"
