"""acr_tape — TapeSource ingestion (SimSource + ArcSource + ReceiptSource + GraphSource)."""

from __future__ import annotations

from .arc_source import ArcSource
from .base import TapeSource
from .graph_client import graph_paged, graph_query
from .graph_source import GraphSource
from .receipt_source import ReceiptSource
from .sim_source import SimSource

__all__ = ["TapeSource", "SimSource", "ArcSource", "ReceiptSource", "GraphSource", "graph_query", "graph_paged"]

__version__ = "0.1.0"
