"""acr_tape — TapeSource ingestion interface (SimSource + ArcSource)."""

from __future__ import annotations

from .arc_source import ArcSource
from .base import TapeSource
from .sim_source import SimSource

__all__ = ["TapeSource", "SimSource", "ArcSource"]

__version__ = "0.1.0"
