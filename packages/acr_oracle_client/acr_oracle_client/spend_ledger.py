"""``SpendLedger`` — what the agent actually paid, read from Arc rather than from us.

``PolicyWallet`` emits ``Spent`` on every payment and refuses a zero
``decisionHash``, so the chain holds a commitment to the reasoning *before* the
money moves. That makes the log the authority and our ``operator_decisions.jsonl``
the copy — which matters because the copy lives on a container disk that no Render
plan in ``render.yaml`` persists, while the log cannot be edited by anyone.

Everything the surveillance product reports is derivable from these nine fields:
budget pressure (``spent_in_period_usdc`` against ``cap_usdc``), which rung
authorized a payment (``owner_approved``), who acted (``actor``), and the join key
back to the stated reasoning (``decision_hash``).

WHY THIS IS NOT ``ArcSource``. ``acr_tape.arc_source`` already reads logs, and on
an over-wide range it halves the span and *keeps only the most recent half* —
then returns ``[]`` if that still fails. For a tape of market exhaust, where the
recent window is the useful one, that is a defensible trade. For an audit it is a
silent lie: the answer looks like "no payments" and actually means "I did not
look". So this pages FORWARD over the whole range, accumulating, and **raises**
rather than returning a short list.

MEASURED, 2026-10-28, against ``rpc.mainnet.arc.io`` and ``rpc.testnet.arc.io``:
a 5,000-block ``eth_getLogs`` answers; 10,000 and 14,000 both come back
``-32012 requested range too large``. Earlier notes in this repo say ~15,000;
the cap today is tighter, so the default window is the largest size actually
observed to work and the shrink path exists for the day it tightens again.
Reach comes from paging. Narrowing destroys it.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

log = logging.getLogger("acr_oracle_client.spend_ledger")

USDC = 10**6

#: The largest range observed to answer on Arc (see the module note). Not a
#: guess at the node's real limit: a size that has returned data.
MAX_WINDOW = 5_000

#: Below this a window is too small to be worth retrying — if a 128-block range
#: will not answer, the problem is not the range.
MIN_WINDOW = 128


class LedgerUnreadable(RuntimeError):
    """A range could not be read, so no claim is made about it.

    Deliberately an exception and not an empty list. An audit that cannot see a
    stretch of chain must say so: "the agent made no payments" and "I could not
    look" are opposite findings, and a caller that receives ``[]`` for both will
    publish the first one.
    """


@dataclass(frozen=True)
class Spend:
    """One ``Spent`` event, decoded. Amounts are USDC, not 6-decimal units."""

    block: int
    tx: str
    log_index: int
    category: str
    to: str
    actor: str
    amount_usdc: float
    decision_hash: str
    owner_approved: bool
    spent_in_period_usdc: float
    cap_usdc: float
    period_start: int

    @property
    def headroom_usdc(self) -> float:
        """What was left in the category after this payment."""
        return max(self.cap_usdc - self.spent_in_period_usdc, 0.0)

    @property
    def utilisation(self) -> float | None:
        """Share of the category cap consumed once this payment landed."""
        if self.cap_usdc <= 0:
            return None
        return self.spent_in_period_usdc / self.cap_usdc


@dataclass(frozen=True)
class Reach:
    """Proof of what was actually covered, returned beside every result.

    A result without this is a number with no provenance: the caller cannot tell
    a quiet wallet from a short read. ``pages`` and ``window`` are reported
    because a shrink is a signal about the node, and a reader comparing two runs
    should be able to see that the second one worked harder for the same answer.
    """

    from_block: int
    to_block: int
    pages: int
    window: int
    shrinks: int

    @property
    def blocks(self) -> int:
        return max(0, self.to_block - self.from_block + 1)

    def as_dict(self) -> dict:
        return {
            "from_block": self.from_block,
            "to_block": self.to_block,
            "blocks": self.blocks,
            "pages": self.pages,
            "window": self.window,
            "shrinks": self.shrinks,
        }


#: Phrases that mean "your range is too wide", across the dialects Arc and its
#: proxies actually emit. Copied in spirit from ``ArcSource``, which learned them
#: the hard way: treating the JSON-RPC form as a hard failure returned an empty
#: tape from a chain that was answering perfectly well.
_TOO_WIDE = (
    "413",
    "-32012",
    "-32602",
    "too large",
    "entity too large",
    "range too large",
    "exceeds max results",
    "query returned more than",
    "log response size exceeded",
)

_THROTTLED = ("429", "too many", "rate limit", "rate-limit")

#: Transient node faults, retried on the SAME range like a throttle.
#:
#: `-32603 internal error` is in here because the very first live run of this
#: class hit one on a 5,000-block range that a raw `curl` of the identical
#: filter answered with five logs seconds earlier, and that the same web3 call
#: answered on the retry. Treating it as fatal made a healthy chain look
#: unreadable; treating it as a width problem would have shrunk the window for
#: no reason. It is neither — it is noise, and the answer to noise is to ask
#: again.
_TRANSIENT = (
    "-32603",
    "internal error",
    "timeout",
    "timed out",
    "502",
    "503",
    "504",
    "bad gateway",
    "connection reset",
    "connection aborted",
    "remote end closed",
)


def _is(msg: str, needles: tuple[str, ...]) -> bool:
    low = msg.lower()
    return any(n in low for n in needles)


class SpendLedger:
    """Pages ``Spent`` logs out of one ``PolicyWallet``.

    Reuses ``PolicyClient``'s connection and contract rather than building a
    second web3 stack, so there is one place where the RPC URL, the wallet
    address and the ABI are decided.
    """

    def __init__(
        self,
        client,
        window: int = MAX_WINDOW,
        attempts: int = 4,
        backoff_s: float = 1.5,
        sleep=time.sleep,
    ) -> None:
        self.client = client
        self.window = min(int(window), MAX_WINDOW)
        self.attempts = max(1, int(attempts))
        self.backoff_s = backoff_s
        self._sleep = sleep

    # --- plumbing -----------------------------------------------------------

    def head(self) -> int | None:
        w3 = self.client.web3()
        if w3 is None:
            return None
        try:
            return int(w3.eth.block_number)
        except Exception as exc:  # pragma: no cover - live chain
            log.warning("SpendLedger: head unreadable (%s)", exc)
            return None

    def _event(self):
        return self.client._contract().events.Spent()

    def _page(self, event, lo: int, hi: int) -> list:
        """One window, with retries. Raises rather than shrinking or giving up.

        A throttle or a transient node fault is retried on the SAME range:
        backing off and asking again is how reach survives a rate limit, whereas
        shrinking turns a passing 429 into permanent blindness.
        """
        last = ""
        for attempt in range(self.attempts):
            try:
                return list(event.get_logs(from_block=lo, to_block=hi))
            except Exception as exc:
                last = str(exc)
                if _is(last, _THROTTLED) or _is(last, _TRANSIENT):
                    self._sleep(self.backoff_s * (attempt + 1))
                    continue
                raise
        raise LedgerUnreadable(
            f"blocks {lo}-{hi} unread after {self.attempts} attempts: {last}"
        )

    # --- the read -----------------------------------------------------------

    def spends(self, from_block: int, to_block: int | None = None) -> tuple[list[Spend], Reach]:
        """Every ``Spent`` in ``[from_block, to_block]``, in chain order.

        Pages forward. Shrinks the window only when the node says the range is
        too wide, and then continues from the same cursor at the smaller size —
        so a shrink costs requests, never coverage.
        """
        if not self.client.wallet_address:
            raise LedgerUnreadable("no wallet address configured")
        if self.client.web3() is None:
            raise LedgerUnreadable(f"no connection to {self.client.rpc_url}")

        hi_end = self.head() if to_block is None else int(to_block)
        if hi_end is None:
            raise LedgerUnreadable("chain head unreadable")
        lo_end = max(0, int(from_block))
        if lo_end > hi_end:
            raise LedgerUnreadable(f"empty range: {lo_end} > {hi_end}")

        event = self._event()
        window = self.window
        shrinks = 0
        pages = 0
        out: list[Spend] = []
        cursor = lo_end

        while cursor <= hi_end:
            hi = min(cursor + window - 1, hi_end)
            try:
                logs = self._page(event, cursor, hi)
            except LedgerUnreadable:
                raise
            except Exception as exc:
                if not _is(str(exc), _TOO_WIDE):
                    raise LedgerUnreadable(f"blocks {cursor}-{hi}: {exc}") from exc
                if window <= MIN_WINDOW:
                    raise LedgerUnreadable(
                        f"blocks {cursor}-{hi} refused at the {window}-block floor: {exc}"
                    ) from exc
                window = max(MIN_WINDOW, window // 2)
                shrinks += 1
                log.info("SpendLedger: window -> %d blocks at %d", window, cursor)
                continue  # same cursor: nothing is skipped

            pages += 1
            out.extend(_decode(x) for x in logs)
            cursor = hi + 1

        out.sort(key=lambda s: (s.block, s.log_index))
        return out, Reach(lo_end, hi_end, pages, window, shrinks)


def _decode(entry) -> Spend:
    a = entry["args"]
    return Spend(
        block=int(entry["blockNumber"]),
        tx=_hex(entry["transactionHash"]),
        log_index=int(entry["logIndex"]),
        category=_hex(a["category"]),
        to=str(a["to"]),
        actor=str(a["actor"]),
        amount_usdc=int(a["amount"]) / USDC,
        decision_hash=_hex(a["decisionHash"]),
        owner_approved=bool(a["ownerApproved"]),
        spent_in_period_usdc=int(a["spentInPeriod"]) / USDC,
        cap_usdc=int(a["cap"]) / USDC,
        period_start=int(a["periodStart"]),
    )


def _hex(v) -> str:
    """``0x``-prefixed lowercase hex, whatever web3 handed back."""
    if isinstance(v, bytes | bytearray):
        return "0x" + bytes(v).hex()
    s = str(v)
    return s if s.startswith("0x") else "0x" + s
