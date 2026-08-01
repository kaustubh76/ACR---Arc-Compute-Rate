"""The Public Desk — terminal visitors trade ACRFutures with a Circle
user-controlled wallet (SCA on Arc Testnet, Gas Station-sponsored gas).

Backend half of the challenge-response model: this module mints Circle users /
session tokens, initializes SCA wallets on ``ARC-TESTNET``, drips a capped
USDC collateral stake from the custody wallet, and creates contractExecution
challenges (approve / postCollateral / trade). The frontend Web SDK
(`@circle-fin/w3s-pw-web-sdk`) executes the challengeIds — the user's PIN
authorizes every on-chain action; this server never holds their key.

All Circle calls go through :func:`_circle` (REST, httpx) — the SDK is
Node-only and the shapes are small. Guardrails live HERE, not in the UI:
faucet caps, qty clamps, trader-roster headroom.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path

import httpx
from acr_core import get_settings

log = logging.getLogger("index_api.desk")

#: The collateral stake the faucet drips (USDC) — enough for dozens of
#: contracts on ACR-GPU/ACR-DATA margins, ~half a contract on ACR-INF.
FAUCET_USDC = 0.5
#: One drip per address, and a global cap so the custody wallet can't drain.
FAUCET_GLOBAL_CAP = 25
#: Never drip the funding wallet below this. An independent backstop on top of
#: the ledger: durable by construction, needs no API, and states the real
#: constraint ("don't drain the wallet") rather than a proxy for it.
FAUCET_RESERVE_USDC = 2.0
#: Refuse new desk traders when the on-chain roster nears MAX_TRADERS (128).
TRADER_HEADROOM = 120
#: The taker's per-trade clamp (contracts). Small by design — the desk is a
#: hands-on demo, not a venue for size.
MAX_QTY = 2.0
#: Only ever quote/spend this fraction of true margin capacity: the mark moves
#: between the quote and the fill, and a revert costs the reader a PIN ceremony.
MARGIN_SAFETY = 0.90
#: Below this the position is dust — refuse rather than mint a doomed challenge.
MIN_QTY = 0.05
#: Held back from the collateral post to cover that tx's own gas when the SCA
#: turns out NOT to be Gas Station-sponsored (on Arc, gas is USDC).
GAS_RESERVE_USDC = 0.01
#: Stop offering a series this long before it expires. Generous on purpose: the
#: desk read is 90s-cached (``onchain.FUTURES_TTL_S``) and a challenge minted
#: now is only signed after the reader's PIN ceremony.
EXPIRY_BUFFER_S = 120.0
#: Quote a withdrawal slightly under the true free margin — ``_requiredMargin``
#: rises with the mark, so a tick between the quote and the signature would
#: revert "below margin" on an exact quote.
WITHDRAW_SAFETY = 0.95
#: Below this a withdrawal isn't worth a PIN ceremony.
MIN_WITHDRAW_USDC = 0.01
USDC_PREDEPLOY = "0x3600000000000000000000000000000000000000"


class DeskError(Exception):
    """A user-visible desk failure (mapped to an HTTP 4xx/502 in app.py)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class _TTLCache:
    """A tiny bounded TTL memo. Bounded matters: these are keyed by caller-
    supplied wallet address, so an unbounded dict is a memory-growth vector on
    a public endpoint, not just an untidiness."""

    def __init__(self, ttl_s: float, max_entries: int) -> None:
        self._ttl, self._max = ttl_s, max_entries
        self._data: OrderedDict[object, tuple[float, object]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            if time.monotonic() - hit[0] >= self._ttl:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return hit[1]

    def put(self, key, value) -> None:
        with self._lock:
            self._data[key] = (time.monotonic(), value)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)  # evict least-recently-used

    def drop(self, key) -> None:
        with self._lock:
            self._data.pop(key, None)


#: Short-lived read memos. Bounded on purpose: every one of these is keyed
#: by a caller-supplied wallet address on a public endpoint, so an unbounded
#: dict is a memory-growth vector rather than merely untidy.
_limits_memo = _TTLCache(ttl_s=8.0, max_entries=512)
_maker_coll_memo = _TTLCache(ttl_s=60.0, max_entries=32)


def _circle(
    method: str,
    path: str,
    body: dict | None = None,
    user_token: str | None = None,
) -> dict:
    """One Circle REST call. Raises :class:`DeskError` with Circle's message on
    a 4xx (the UI shows it verbatim) and a generic 502 on transport failure."""
    s = get_settings()
    headers = {
        "Authorization": f"Bearer {s.circle_api_key}",
        "Content-Type": "application/json",
        # Cloudflare rejects requests without a UA (error 1010).
        "User-Agent": "acr-index-desk/1.0",
    }
    if user_token:
        headers["X-User-Token"] = user_token
    try:
        r = httpx.request(
            method, f"{s.circle_base_url}{path}", headers=headers, json=body, timeout=15.0
        )
    except Exception as exc:
        log.warning("circle %s %s transport failure: %s", method, path, exc)
        raise DeskError(502, "Circle API unreachable") from exc
    if r.status_code >= 400:
        try:
            payload = r.json()
        except Exception:
            payload = {}
        code = payload.get("code")
        message = payload.get("message", r.text[:200])
        raise DeskError(r.status_code, f"circle error {code}: {message}")
    return r.json()


_app_id_memo: str | None = None


def app_id() -> str:
    """The entity's App ID (frontend SDK bootstrap) — fetched once, memoized."""
    global _app_id_memo
    if _app_id_memo is None:
        _app_id_memo = _circle("GET", "/v1/w3s/config/entity")["data"]["appId"]
    return _app_id_memo


ALREADY_EXISTS = 155106  # Circle: user already created / already initialized


def open_session(user_id: str) -> dict:
    """Create-or-resume a desk session: user + 60-min token; a PIN-setup
    challenge on first contact, the existing wallet afterwards."""
    if len(user_id) < 5 or len(user_id) > 64:
        raise DeskError(400, "user_id must be 5-64 characters")
    try:
        _circle("POST", "/v1/w3s/users", {"userId": user_id})
    except DeskError as e:
        if str(ALREADY_EXISTS) not in e.detail and e.status != 409:
            raise  # genuinely new failure; 'already exists' is the resume path
    tok = _circle("POST", "/v1/w3s/users/token", {"userId": user_id})["data"]
    out = {
        "app_id": app_id(),
        "user_token": tok["userToken"],
        "encryption_key": tok["encryptionKey"],
        "challenge_id": None,
        "wallet": None,
    }
    try:
        init = _circle(
            "POST",
            "/v1/w3s/user/initialize",
            {
                "idempotencyKey": str(uuid.uuid4()),
                "blockchains": ["ARC-TESTNET"],
                "accountType": "SCA",
            },
            user_token=tok["userToken"],
        )["data"]
        out["challenge_id"] = init.get("challengeId")
    except DeskError as e:
        if str(ALREADY_EXISTS) not in e.detail:
            raise
        out["wallet"] = wallet_of(tok["userToken"])  # resumed session
    return out


def wallet_of(user_token: str) -> dict | None:
    """The user's ARC-TESTNET wallet ``{wallet_id, address}`` (None pre-PIN)."""
    wallets = _circle("GET", "/v1/w3s/wallets", user_token=user_token)["data"].get(
        "wallets", []
    )
    for w in wallets:
        if w.get("blockchain") == "ARC-TESTNET":
            return {"wallet_id": w["id"], "address": w["address"]}
    return None


#: Re-ask Circle this often, so a process that booted during a Circle blip
#: converges instead of staying degraded for its whole lifetime.
_HYDRATE_TTL_S = 600.0


class FaucetLedger:
    """Once-per-address, globally-capped drip ledger.

    Persisted two ways, unioned: a local JSONL (authoritative and free when
    there IS a disk) and Circle's own record of the transfers (authoritative
    where there isn't — the production host has no persistent disk, so the file
    is empty on every boot). See :meth:`_rehydrate_from_circle`.

    **Fails closed.** If the Circle side can't be reached, no drip is issued at
    all. Failing open would restore precisely the bug this exists to prevent —
    a restart that hands out fresh drips to addresses already paid — and the
    cost of failing closed is that a reader waits half a minute.
    """

    def __init__(self, log_path: str | None = None, *, require_circle: bool = False) -> None:
        self._lock = threading.Lock()
        self._dripped: dict[str, float] = {}
        if log_path is None:
            log_path = str(Path(get_settings().webhook_log_path or "data/x.jsonl").parent / "desk_faucet.jsonl")
        self._log_path = log_path
        #: Off in tests and local runs (the file is real there); on in the app.
        self._require_circle = require_circle
        self._hydrated_at = 0.0
        self._rehydrate()

    def _ensure_hydrated(self) -> None:
        """Refresh from Circle when required and stale. Raises (fail-closed) if
        the record can't be read and this ledger is configured to require it."""
        if not self._require_circle:
            return
        if time.monotonic() - self._hydrated_at < _HYDRATE_TTL_S:
            return
        try:
            self._rehydrate_from_circle()
            self._hydrated_at = time.monotonic()
        except Exception as exc:
            log.warning("faucet ledger could not reach Circle: %s", exc)
            raise DeskError(503, "the faucet is warming up — try again in a moment") from exc

    def _rehydrate(self) -> None:
        """Load prior drips from the local JSONL. Durable only where the disk is
        — see :meth:`_rehydrate_from_circle`, which is what makes the caps real
        on an ephemeral host."""
        if not self._log_path:
            return
        p = Path(self._log_path)
        if not p.exists():
            return
        for line in p.read_text().splitlines():
            try:
                row = json.loads(line)
                self._dripped[row["address"].lower()] = row["at"]
            except Exception:
                continue

    def _rehydrate_from_circle(self) -> None:
        """Rebuild the ledger from Circle's own record of the drips.

        The JSONL is written to a container filesystem with no persistent disk,
        so in production it is empty on every boot — meaning the one-drip-per-
        address rule and the global cap silently reset on each restart and could
        be farmed. Circle keeps the transfers, so ask it.

        The custody wallet's OUTBOUND rows are useless here (the drip is sent as
        raw calldata, so Circle records no destination or amount), but the
        mirrored INBOUND row on each recipient's own wallet carries both. That
        only sees wallets under our entity — which is exactly what the
        session-derived faucet address guarantees, so the two changes belong
        together.

        Counts every non-failed state, so an in-flight drip still holds its slot.
        """
        rows = _circle(
            "GET",
            "/v1/w3s/transactions?blockchain=ARC-TESTNET&custodyType=ENDUSER"
            "&operation=TRANSFER&pageSize=50",
        )["data"].get("transactions", [])
        for t in rows:
            if (t.get("state") or "").upper() == "FAILED":
                continue
            dest = (t.get("destinationAddress") or "").lower()
            if dest:
                self._dripped.setdefault(dest, time.time())

    def claim(self, address: str) -> None:
        """Reserve a drip slot or raise (409 dup / 429 exhausted / 503 unknown)."""
        self._ensure_hydrated()
        a = address.lower()
        with self._lock:
            if a in self._dripped:
                raise DeskError(409, "this wallet already took its stake")
            if len(self._dripped) >= FAUCET_GLOBAL_CAP:
                raise DeskError(429, "the faucet's global stake budget is spent")
            self._dripped[a] = time.time()
            if self._log_path:
                try:
                    p = Path(self._log_path)
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with p.open("a") as f:
                        f.write(json.dumps({"address": a, "at": self._dripped[a]}) + "\n")
                except Exception as exc:  # pragma: no cover - disk hiccup
                    log.warning("faucet ledger append failed: %s", exc)

    def release(self, address: str) -> None:
        """Roll back a claim whose transfer failed (no ledger line rewrite —
        the in-memory slot frees; a restart forgives it, which is fine)."""
        with self._lock:
            self._dripped.pop(address.lower(), None)

    def record_tx(self, address: str, tx: str) -> None:
        """Append the confirmed drip's tx hash — the claim line is written before
        the transfer (so a crash can't be farmed), this line is the receipt."""
        if not self._log_path:
            return
        try:
            p = Path(self._log_path)
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("a") as f:
                f.write(
                    json.dumps({"address": address.lower(), "at": time.time(), "tx": tx}) + "\n"
                )
        except Exception as exc:  # pragma: no cover - disk hiccup
            log.warning("faucet ledger receipt append failed: %s", exc)

    def status(self, address: str) -> dict:
        """What the UI needs to narrate the drip: claimed? confirmed? which tx?"""
        a = address.lower()
        with self._lock:
            claimed = a in self._dripped
        return {"claimed": claimed, "tx": _drip_tx.get(a), "spent": self.spent()}

    def spent(self) -> int:
        with self._lock:
            return len(self._dripped)


_ledger: FaucetLedger | None = None


def get_ledger() -> FaucetLedger:
    """The app's ledger. Requires the Circle record because the deployed host
    has no persistent disk — see FaucetLedger. Tests build their own."""
    global _ledger
    if _ledger is None:
        _ledger = FaucetLedger(require_circle=True)
    return _ledger


#: Confirmed drip hashes by address — the receipt the UI/evidence script reads
#: back (the transfer itself confirms long after the HTTP request returns).
_drip_tx = _TTLCache(ttl_s=3600.0, max_entries=64)


def _custody_balance() -> float | None:
    """The funding wallet's USDC. ``None`` when it can't be read — the ledger is
    the primary gate, so a throttled RPC must not become a faucet outage."""
    try:
        from acr_oracle_client.signer import CircleWalletSigner

        s = get_settings()
        signer = CircleWalletSigner(
            wallet_id=s.circle_wallet_id, api_key=s.circle_api_key,
            entity_secret=s.circle_entity_secret, base_url=s.circle_base_url,
        )
        return _wallet_usdc(signer.address)
    except Exception:
        return None


def _send_stake(address: str) -> str:
    """The custody-wallet transfer itself (the SAME CircleWalletSigner path the
    prod poster uses). Blocks on Circle's confirm poll — callers run it off the
    request thread. Returns the tx hash."""
    from acr_oracle_client.signer import CircleWalletSigner

    s = get_settings()
    signer = CircleWalletSigner(
        wallet_id=s.circle_wallet_id,
        api_key=s.circle_api_key,
        entity_secret=s.circle_entity_secret,
        base_url=s.circle_base_url,
    )
    amount = int(FAUCET_USDC * 1_000_000)
    calldata = (
        "0xa9059cbb"
        + address.lower().replace("0x", "").rjust(64, "0")
        + hex(amount)[2:].rjust(64, "0")
    )
    return signer.send_transaction(None, {"to": USDC_PREDEPLOY, "data": calldata})


def drip_stake(user_token: str) -> dict:
    """Drip the stake to THIS SESSION'S wallet.

    The destination is derived from the session token, never taken from the
    caller. It used to be a plain body field validated only as "looks like an
    address" — and since the endpoint is unauthenticated and CORS is open, the
    browser proxy's checks were trivially bypassable, so anyone could pour the
    whole faucet budget into addresses they chose. A valid ``user_token`` is
    proof the caller completed Circle's PIN ceremony for a user under *our*
    entity, which is exactly the property the faucet needs.

    The transfer itself is fire-and-forget: Circle's confirm poll runs up to
    120s and the browser's proxy hop gives up at 20s, so waiting could only ever
    time out — burning the address's one slot on a transfer that then succeeded.
    The slot is reserved on this thread (the cap stays honest) and the transfer
    confirms on a daemon thread. The UI polls its wallet balance.
    """
    w = wallet_of(user_token)
    if w is None:
        raise DeskError(409, "set your PIN first — the wallet isn't provisioned yet")
    address = _checksum(w["address"])

    # An independent, zero-API backstop on top of the ledger: whatever the
    # ledger believes, never drain the wallet that funds every drip.
    custody = _custody_balance()
    if custody is not None and custody - FAUCET_USDC < FAUCET_RESERVE_USDC:
        raise DeskError(429, "the faucet is out of funds for now")

    ledger = get_ledger()
    ledger.claim(address)

    def _confirm() -> None:
        try:
            tx = _send_stake(address)
        except Exception as exc:
            ledger.release(address)
            log.warning("desk faucet transfer failed for %s: %s", address, exc)
            return
        _drip_tx.put(address.lower(), tx)
        ledger.record_tx(address, tx)
        log.info("desk faucet: %.2f USDC -> %s (%s)", FAUCET_USDC, address, tx)

    threading.Thread(target=_confirm, name="desk-faucet", daemon=True).start()
    return {"state": "pending", "amount_usdc": FAUCET_USDC}


def _live_series(index_id: str) -> dict:
    """The TRADABLE series for an index (the same selection the desk shows).

    "Tradable" is stricter than "unsettled": the contract rejects a trade at
    ``block.timestamp >= expiryTs``, and a desk action is not one round trip —
    the reader still has a PIN ceremony to complete after the challenge is
    minted. Without the buffer the desk would mint challenges that revert
    *after* the reader has authorized them, which reads as a silent failure.
    """
    from .onchain import get_futures

    futures = get_futures()
    if not futures.configured:
        raise DeskError(503, "no futures venue configured")
    desk = futures.read_all().get(index_id)
    if desk is None or desk.get("settled"):
        raise DeskError(404, f"no open series for {index_id}")
    if desk.get("expiry_ts", 0) - time.time() <= EXPIRY_BUFFER_S:
        raise DeskError(
            409,
            f"the {index_id} series has expired — nothing new can be traded on it. "
            "Withdraw your collateral once it settles.",
        )
    if desk.get("trader_count", 0) >= TRADER_HEADROOM:
        raise DeskError(409, "this series' trader roster is full")
    return desk


def feasible_qty(
    mark: float,
    multiplier: int,
    margin_bps: int,
    taker_collateral: float,
    taker_contracts: float,
    maker_collateral: float,
    maker_contracts: float,
) -> tuple[float, float]:
    """``(max_buy, max_sell)`` in contracts — the largest trade each way that
    clears ``ACRFutures.trade``'s BOTH margin checks.

    The contract requires, post-fill, ``collateral >= |contracts|·mark·mult·
    MARGIN_BPS`` for the taker *and* the auto-mirrored maker. A buy of ``q``
    takes the taker to ``t+q`` and the maker to ``m-q``; a sell mirrors it. So
    each side contributes a cap and the tighter one wins — quoted at
    ``MARGIN_SAFETY`` so a mark tick between quote and fill can't revert a
    trade the reader already authorized with their PIN.
    """
    per_contract = mark * multiplier * (margin_bps / 10_000)
    if per_contract <= 0:
        return (0.0, 0.0)
    t_cap = MARGIN_SAFETY * taker_collateral / per_contract
    m_cap = MARGIN_SAFETY * maker_collateral / per_contract
    max_buy = min(t_cap - taker_contracts, m_cap + maker_contracts)
    max_sell = min(t_cap + taker_contracts, m_cap - maker_contracts)
    clamp = lambda x: round(max(0.0, min(MAX_QTY, x)), 2)  # noqa: E731
    return (clamp(max_buy), clamp(max_sell))


def free_collateral_units(
    units: int,
    contracts: float,
    mark: float,
    multiplier: int,
    margin_bps: int,
    settled: bool,
) -> int:
    """How much of a posted stake (RAW USDC-6) the contract will actually let go.

    Mirrors ``ACRFutures.withdrawCollateral``: what stays behind must still cover
    initial margin on the open position — except on a settled series, where
    positions are flat and the whole cleared balance is free. A flat account
    needs no margin either, which is why neither of those cases reads a mark.

    Pure arithmetic on purpose: this is the part worth asserting in a unit test,
    while the reads that feed it are proven against a real chain (see
    tests/test_desk_onchain.py) rather than against a stand-in.
    """
    if units <= 0:
        return 0
    if settled or contracts == 0:
        return units
    required = abs(contracts) * mark * multiplier * (margin_bps / 10_000)
    free = max(0.0, units / 1_000_000 - required)
    return int(free * WITHDRAW_SAFETY * 1_000_000)


#: Arc's public RPC throttles hard and the desk polls alongside the tape and the
#: position read — without the memos above, a reader who is simply *looking* at
#: the desk can 429 themselves out of trading.


def _checksum(address: str) -> str:
    """EIP-55 form. web3 refuses a lowercase address, and Circle only ever
    returns lowercase — every address crossing that boundary needs this."""
    try:
        from eth_utils import to_checksum_address

        return to_checksum_address(address)
    except Exception:
        return address


def _maker_collateral(client, sid: int, maker: str) -> float | None:
    """The maker's posted collateral — it only moves when the operator tops the
    book up, so a minute-old value is plenty and saves an RPC call per quote."""
    hit = _maker_coll_memo.get(sid)
    if hit is not None:
        return hit
    val = client.collateral_of(sid, maker)
    if val is not None:
        _maker_coll_memo.put(sid, val)
    return val


def desk_limits(address: str, index_id: str) -> dict:
    """What this wallet can actually trade right now on ``index_id``: the live
    mark plus the per-direction size caps. The UI offers exactly these, so the
    reader never PIN-authorizes a trade the contract will revert."""
    if not (address.startswith("0x") and len(address) == 42):
        raise DeskError(400, "not an address")
    key = (address.lower(), index_id)
    hit = _limits_memo.get(key)
    if hit is not None:
        return hit

    desk = _live_series(index_id)
    from .onchain import get_futures

    client = get_futures()._client
    sid, mult, maker = desk["series_id"], desk["multiplier"], desk["maker"]
    mark = _live_mark(index_id)
    # Circle hands back lowercase addresses; web3 rejects a non-checksum address
    # outright, and the client swallows that as "offline" — which reads as a
    # throttled venue when it is really a formatting mismatch.
    trader = _checksum(address)
    taker_pos = client.position_of(sid, trader) or {"contracts": 0.0}
    taker_coll = client.collateral_of(sid, trader)
    maker_coll = _maker_collateral(client, sid, _checksum(maker))
    if taker_coll is None or maker_coll is None:
        raise DeskError(503, "the venue is not reading right now — try again")
    max_buy, max_sell = feasible_qty(
        mark,
        mult,
        _margin_bps(),
        taker_coll,
        taker_pos["contracts"],
        maker_coll,
        desk.get("maker_inventory", 0.0),
    )
    out = {
        "index_id": index_id,
        "series_id": sid,
        "mark": mark,
        "collateral_usdc": taker_coll,
        "contracts": taker_pos["contracts"],
        "max_buy": max_buy,
        "max_sell": max_sell,
    }
    _limits_memo.put(key, out)
    return out


#: The exit read walks every series (2 RPC calls each) and the UI polls it, so
#: memoize briefly — the numbers only move when the mark or the position does.
_withdrawable_memo = _TTLCache(ttl_s=8.0, max_entries=512)


def withdrawable(address: str) -> dict:
    """What this wallet can take back out, across EVERY series it has collateral
    in — expired and settled ones included.

    Deliberately does NOT go through :func:`_live_series`: the whole point is to
    serve exactly the expired/settled series that gate rejects. That asymmetry
    is the feature — a reader must always be able to leave, even once the market
    they entered has stopped trading.

    The contract's rule (``ACRFutures.withdrawCollateral``) is that what's left
    behind must still cover initial margin, *unless* the series is settled, in
    which case positions are flat and the whole cleared balance is free. Note
    ``_requiredMargin`` returns 0 for a flat account before it ever reads the
    oracle — so a flat trader can withdraw even with no live print.
    """
    if not (address.startswith("0x") and len(address) == 42):
        raise DeskError(400, "not an address")
    from .onchain import get_futures

    client = get_futures()._client
    if not client.configured:
        raise DeskError(503, "no futures venue configured")
    trader = _checksum(address)
    cached = _withdrawable_memo.get(trader.lower())
    if cached is not None:
        return cached

    try:
        rows: list[dict] = []
        for s in client.read_all_series():
            sid = s["series_id"]
            units = client.collateral_units_of(sid, trader)
            if not units:
                continue
            pos = client.position_of(sid, trader) or {"contracts": 0.0}
            contracts = pos["contracts"]
            settled = bool(s.get("settled"))
            # Only an unsettled, non-flat account needs a mark at all — don't
            # make a reader's exit depend on the oracle when the contract won't.
            mark = 0.0 if (settled or contracts == 0) else _live_mark(s["index_id"])
            free_units = free_collateral_units(
                units, contracts, mark, s["multiplier"], _margin_bps(), settled
            )
            rows.append(
                {
                    "series_id": sid,
                    "index_id": s["index_id"],
                    "settled": bool(s.get("settled")),
                    "expired": s.get("expiry_ts", 0) <= time.time(),
                    "collateral_usdc": units / 1_000_000,
                    "contracts": contracts,
                    "free_usdc": free_units / 1_000_000,
                    "free_units": free_units,
                }
            )
    except DeskError:
        raise
    except Exception as exc:
        log.warning("withdrawable read failed for %s: %s", address, exc)
        raise DeskError(503, "the venue is not reading right now — try again") from exc

    # Richest first: the UI offers one row per series, because a roll leaves a
    # returning reader holding collateral in the OLD series and none in the new
    # one — showing only the best would read as money vanishing.
    rows.sort(key=lambda r: r["free_units"], reverse=True)
    out = {
        "series": rows,
        "total_free_usdc": sum(r["free_usdc"] for r in rows),
        # Convenience mirror of the richest row, so a caller that just wants
        # "the withdrawal" (the challenge builder) needn't re-sort.
        **(rows[0] if rows else {"free_usdc": 0.0, "free_units": 0}),
    }
    _withdrawable_memo.put(trader.lower(), out)
    return out


def _live_mark(index_id: str) -> float:
    """The oracle mark ``trade()`` will margin against (it reverts "no mark" at
    zero, so a missing print is a desk-level 503, not a failed PIN ceremony).

    Reads the reader's CACHED sweep, not a fresh single-index call: Arc's RPC
    throttles hard, ``read_latest`` swallows a 429 as None, and a desk that
    503s on a throttle would strand a reader who has already posted collateral.
    The sweep is the same value the terminal is showing anyway."""
    from .onchain import get_reader

    reader = get_reader()
    print_ = reader.read_all().get(index_id) or reader.read(index_id)
    if not print_ or not print_.get("value"):
        raise DeskError(503, f"no live mark for {index_id}")
    return float(print_["value"])


_margin_memo: int | None = None
_MARGIN_ABI = [
    {
        "type": "function",
        "name": "MARGIN_BPS",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    }
]


def _margin_bps() -> int:
    """The venue's initial-margin requirement — immutable on-chain, so read once.
    Falls back to the deployed 2000bps if the RPC is throttled."""
    global _margin_memo
    if _margin_memo is None:
        try:
            from .onchain import get_futures

            client = get_futures()._client
            w3 = client._connect()
            c = w3.eth.contract(
                address=w3.to_checksum_address(client.futures_address), abi=_MARGIN_ABI
            )
            _margin_memo = int(c.functions.MARGIN_BPS().call())
        except Exception:
            return 2000
    return _margin_memo


def _wallet_usdc(address: str) -> float | None:
    """The wallet's USDC (native on Arc — the predeploy is its ERC-20 view)."""
    try:
        from .onchain import get_futures

        w3 = get_futures()._client._connect()
        if w3 is None:
            return None
        return w3.eth.get_balance(w3.to_checksum_address(address)) / 1e18
    except Exception:
        return None


def build_challenge(
    user_token: str,
    wallet_id: str,
    action: str,
    index_id: str,
    qty: float = 0.0,
    address: str = "",
    series_id: int | None = None,
) -> dict:
    """Create the contractExecution challenge for one desk action. The
    abiFunctionSignature form keeps the request auditable (no raw calldata)."""
    s = get_settings()
    venue = s.futures_address
    if not venue:
        raise DeskError(503, "no futures venue configured")

    if action == "approve":
        contract, sig, params = (
            USDC_PREDEPLOY,
            "approve(address,uint256)",
            [venue, str(2**256 - 1)],
        )
    elif action == "collateral":
        desk = _live_series(index_id)
        # Post the stake, but never more than the wallet holds: if Gas Station
        # is NOT sponsoring this SCA, the approve already spent some of the drip
        # as gas (USDC *is* Arc's gas token) and a full-stake postCollateral
        # would revert inside transferFrom. Keep a sliver back for this tx's own
        # gas in that case.
        stake = FAUCET_USDC
        bal = _wallet_usdc(address) if address else None
        if bal is not None and bal < FAUCET_USDC:
            stake = max(0.0, bal - GAS_RESERVE_USDC)
        if stake <= 0:
            raise DeskError(409, "this wallet has no stake to post yet")
        contract, sig, params = (
            venue,
            "postCollateral(uint256,uint256)",
            [str(desk["series_id"]), str(int(stake * 1_000_000))],
        )
    elif action == "trade":
        desk = _live_series(index_id)
        q = max(-MAX_QTY, min(MAX_QTY, float(qty)))
        if q == 0:
            raise DeskError(400, "qty must be non-zero")
        if address:
            # Clamp to what BOTH margin checks allow, so the reader's PIN never
            # authorizes a trade the contract will revert ("taker margin").
            lim = desk_limits(address, index_id)
            cap = lim["max_buy"] if q > 0 else lim["max_sell"]
            if cap < MIN_QTY:
                raise DeskError(
                    409,
                    f"no margin for a {'buy' if q > 0 else 'sell'} right now — "
                    f"post collateral or trade the other way",
                )
            q = min(q, cap) if q > 0 else max(q, -cap)
        contract, sig, params = (
            venue,
            "trade(uint256,int256)",
            [str(desk["series_id"]), str(int(q * 10**18))],
        )
    elif action == "withdraw":
        if not address:
            raise DeskError(400, "withdraw needs the wallet address")
        w = withdrawable(address)
        if series_id is not None:
            # The reader picked a specific series — honour it rather than
            # silently emptying a different one than the button they pressed.
            w = next(
                (r for r in w["series"] if r["series_id"] == series_id),
                {"series_id": series_id, "free_units": 0, "contracts": 0.0},
            )
        if w["free_units"] < int(MIN_WITHDRAW_USDC * 1_000_000):
            # Name the CASE, not just the number — "nothing to withdraw" would
            # be a lie to someone whose money is simply backing a position.
            if w.get("contracts"):
                raise DeskError(
                    409,
                    "your stake is backing an open position — close it, or wait "
                    "for the series to settle, and it frees up",
                )
            raise DeskError(409, "nothing to withdraw")
        contract, sig, params = (
            venue,
            "withdrawCollateral(uint256,uint256)",
            [str(w["series_id"]), str(w["free_units"])],
        )
    else:
        raise DeskError(400, f"unknown action {action!r}")

    # This action is about to change the wallet's on-chain state, so both cached
    # quotes are now wrong — drop them rather than serve stale numbers for 8s.
    if address and action in ("collateral", "trade", "withdraw"):
        _limits_memo.drop((address.lower(), index_id))
        _withdrawable_memo.drop(_checksum(address).lower())

    ch = _circle(
        "POST",
        "/v1/w3s/user/transactions/contractExecution",
        {
            "idempotencyKey": str(uuid.uuid4()),
            "walletId": wallet_id,
            "contractAddress": contract,
            "abiFunctionSignature": sig,
            "abiParameters": params,
            "feeLevel": "MEDIUM",
        },
        user_token=user_token,
    )["data"]
    return {"challenge_id": ch.get("challengeId"), "action": action}
