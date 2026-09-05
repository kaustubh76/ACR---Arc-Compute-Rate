"""Oracle-poster job — each cycle: estimate → EIP-712 sign → post on-chain.

The scheduled task (driven by the app lifespan at ``ACR_REFRESH_SECONDS``) that
keeps ``ACROracle.sol`` fresh. Each cycle refreshes the store's prints and pushes
each one through ``OracleClient`` (EIP-712 sign + ``postPrint``). A single index's
failure (e.g. a transient revert) is isolated so the rest still post. Offline, the
client logs the payload it *would* post, so the loop is observable without a live
chain.
"""

from __future__ import annotations

import asyncio
import logging
import time

from acr_oracle_client import OracleClient

from .store import PrintStore

log = logging.getLogger("index_api.poster")


def _build_v2_client() -> OracleClient | None:
    """The v2 oracle client, or None when no v2 address is configured."""
    from acr_core import get_settings
    from acr_oracle_client.client import ORACLE_V2

    s = get_settings()
    if not getattr(s, "oracle_v2_address", ""):
        return None
    return OracleClient(oracle_address=s.oracle_v2_address, schema=ORACLE_V2)


class OraclePoster:
    def __init__(
        self,
        store: PrintStore,
        client: OracleClient | None = None,
        v2_client: OracleClient | None = None,
    ) -> None:
        self.store = store
        self.client = client or OracleClient()
        #: The v2 oracle, built from settings rather than passed in. Every entry
        #: point that posts — the service loop and ``scripts/post_once.py`` —
        #: constructs an ``OraclePoster`` the same way, so building it here means
        #: there is no path where one of them dual-posts and the other silently
        #: does not. None until ``ACR_ORACLE_V2_ADDRESS`` is set.
        self.v2 = v2_client if v2_client is not None else _build_v2_client()
        self.posts = 0
        #: Per-index provenance of the latest post attempt — {tx, block, at_wall}
        #: from the client's receipt on success; a "offline"/"error" note otherwise.
        #: The Terminal's chain panel reads this via ``build_terminal_payload``.
        self.last_posts: dict[str, dict] = {}

    def rehydrate(self, posts: list[dict]) -> int:
        """Seed provenance from on-chain ``PricePosted`` events (chronological,
        as ``OracleClient.recent_posts`` returns them) after a cold start —
        ``last_posts`` is in-memory, so without this the Terminal's provenance
        panel says "awaiting first live post" until the NEXT hourly post even
        though real posts sit on chain. Never overwrites live state."""
        if self.last_posts or not posts:
            return 0
        for ev in posts:  # chronological — the newest per index wins
            self.last_posts[ev["index_id"]] = {
                "tx": ev["tx"], "block": ev["block"], "at_wall": ev["at_wall"],
            }
        self.posts = max(self.posts, len(posts))
        return len(posts)

    def post_latest(self, only: set[str] | None = None) -> list[str]:
        """Post the store's current prints. Per-index try/except so one index's
        revert doesn't abort the rest. Returns tx refs / offline / error markers.

        ``only`` restricts the post to named indices — the off-cycle recovery
        path uses it to re-post just the stale one. Every print costs real gas,
        and that path can fire repeatedly while a single index keeps failing, so
        re-posting the two that are already fresh is money for nothing.
        """
        refs: list[str] = []
        for iid, p in list(self.store.latest.items()):
            if only is not None and iid not in only:
                continue
            try:
                tx = self.client.post(p)
                refs.append(tx or f"offline:{iid}")
            except Exception as exc:  # isolate a single index's failure
                log.warning("post failed for %s: %s", iid, exc)
                refs.append(f"error:{iid}")
                self.last_posts[iid] = {"tx": None, "block": None,
                                        "at_wall": time.time(), "note": "error"}
                continue
            if tx is None:
                self.last_posts[iid] = {"tx": None, "block": None,
                                        "at_wall": time.time(), "note": "offline"}
            else:
                rcpt = getattr(self.client, "last_receipt", None) or {}
                self.last_posts[iid] = {"tx": rcpt.get("tx") or tx,
                                        "block": rcpt.get("block"),
                                        "at_wall": time.time()}
            self.posts += 1

            # --- the v2 mirror, deliberately ASYMMETRIC -----------------------
            # v1 is the venue's feed: ACRFutures.settle() refuses a print older
            # than two hours and its oracle pointer is immutable, so a stale v1
            # strands collateral in every expired series. v2 is the tape's
            # feed: a gap there only makes the arrival ring sparse, which the
            # subgraph already reports honestly as `benchmarked: false`.
            #
            # So a v1 failure aborts this index's cycle (above, unchanged) and a
            # v2 failure is recorded and stepped over. A tape problem must never
            # be able to stop the press.
            if self.v2 is not None:
                try:
                    v2_tx = self.v2.post(p)
                    self.last_posts[iid]["v2"] = v2_tx or "offline"
                except Exception as exc:  # noqa: BLE001 — the reason, not the trace
                    log.warning("v2 post failed for %s: %s", iid, str(exc)[:160])
                    self.last_posts[iid]["v2"] = f"error: {str(exc)[:80]}"
        return refs

    def post_once(self, ts: float | None = None) -> list[str]:
        """Refresh prints, then post each (used by scripts/tests)."""
        self.store.refresh(ts=ts)
        return self.post_latest()

    async def run(self, interval_s: float = 3600.0, stop: asyncio.Event | None = None) -> None:
        """Loop forever (or until ``stop``), posting every ``interval_s``."""
        while stop is None or not stop.is_set():
            try:
                refs = self.post_once()  # refresh + post
                log.info("posted %d prints: %s", len(refs), refs)
            except Exception as exc:  # pragma: no cover - keep the loop alive
                log.exception("poster cycle failed: %s", exc)
            try:
                await asyncio.wait_for(
                    stop.wait() if stop else asyncio.sleep(interval_s), timeout=interval_s
                )
            except TimeoutError:
                pass
