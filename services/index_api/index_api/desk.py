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
from pathlib import Path

import httpx
from acr_core import get_settings

log = logging.getLogger("index_api.desk")

#: The collateral stake the faucet drips (USDC) — enough for dozens of
#: contracts on ACR-GPU/ACR-DATA margins, ~half a contract on ACR-INF.
FAUCET_USDC = 0.5
#: One drip per address, and a global cap so the custody wallet can't drain.
FAUCET_GLOBAL_CAP = 25
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
USDC_PREDEPLOY = "0x3600000000000000000000000000000000000000"


class DeskError(Exception):
    """A user-visible desk failure (mapped to an HTTP 4xx/502 in app.py)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


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


class FaucetLedger:
    """Once-per-address, globally-capped drip ledger — JSONL-persisted so a
    restart can't be farmed for extra drips (webhooks.py idiom)."""

    def __init__(self, log_path: str | None = None) -> None:
        self._lock = threading.Lock()
        self._dripped: dict[str, float] = {}
        if log_path is None:
            log_path = str(Path(get_settings().webhook_log_path or "data/x.jsonl").parent / "desk_faucet.jsonl")
        self._log_path = log_path
        self._rehydrate()

    def _rehydrate(self) -> None:
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

    def claim(self, address: str) -> None:
        """Reserve a drip slot or raise (409 dup / 429 exhausted)."""
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
    global _ledger
    if _ledger is None:
        _ledger = FaucetLedger()
    return _ledger


#: Confirmed drip hashes by address — the receipt the UI/evidence script reads
#: back (the transfer itself confirms long after the HTTP request returns).
_drip_tx: dict[str, str] = {}


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


def drip_stake(address: str) -> dict:
    """Claim a drip slot and start the 0.5 USDC transfer — **without waiting for
    it**. Circle's confirm poll runs up to 120s; the browser's proxy hop gives up
    at 20s, so a synchronous drip could only ever time out (burning the address's
    one slot on a transfer that then succeeded). The slot is reserved on this
    thread — the cap stays honest — and the transfer confirms on a daemon thread
    that records the hash or frees the slot. The UI polls its wallet balance."""
    if not (address.startswith("0x") and len(address) == 42):
        raise DeskError(400, "not an address")
    ledger = get_ledger()
    ledger.claim(address)

    def _confirm() -> None:
        try:
            tx = _send_stake(address)
        except Exception as exc:
            ledger.release(address)
            log.warning("desk faucet transfer failed for %s: %s", address, exc)
            return
        _drip_tx[address.lower()] = tx
        ledger.record_tx(address, tx)
        log.info("desk faucet: %.2f USDC -> %s (%s)", FAUCET_USDC, address, tx)

    threading.Thread(target=_confirm, name="desk-faucet", daemon=True).start()
    return {"state": "pending", "amount_usdc": FAUCET_USDC}


def _live_series(index_id: str) -> dict:
    """The tradable series for an index (the same selection the desk shows)."""
    from .onchain import get_futures

    futures = get_futures()
    if not futures.configured:
        raise DeskError(503, "no futures venue configured")
    desk = futures.read_all().get(index_id)
    if desk is None or desk.get("settled"):
        raise DeskError(404, f"no open series for {index_id}")
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


#: Per-wallet limits memo. Arc's public RPC throttles hard and the desk polls
#: alongside the tape and the position read — without this, a reader who is
#: simply *looking* at the desk can 429 themselves out of trading.
_LIMITS_TTL_S = 8.0
_MAKER_COLL_TTL_S = 60.0
_limits_memo: dict[tuple[str, str], tuple[float, dict]] = {}
_maker_coll_memo: dict[int, tuple[float, float]] = {}


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
    if hit and time.monotonic() - hit[0] < _MAKER_COLL_TTL_S:
        return hit[1]
    val = client.collateral_of(sid, maker)
    if val is not None:
        _maker_coll_memo[sid] = (time.monotonic(), val)
    return val


def desk_limits(address: str, index_id: str) -> dict:
    """What this wallet can actually trade right now on ``index_id``: the live
    mark plus the per-direction size caps. The UI offers exactly these, so the
    reader never PIN-authorizes a trade the contract will revert."""
    if not (address.startswith("0x") and len(address) == 42):
        raise DeskError(400, "not an address")
    key = (address.lower(), index_id)
    hit = _limits_memo.get(key)
    if hit and time.monotonic() - hit[0] < _LIMITS_TTL_S:
        return hit[1]

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
    _limits_memo[key] = (time.monotonic(), out)
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
    else:
        raise DeskError(400, f"unknown action {action!r}")

    # This action is about to change the wallet's on-chain state, so the cached
    # quote is now wrong — drop it rather than serve a stale cap for 8s.
    if address and action in ("collateral", "trade"):
        _limits_memo.pop((address.lower(), index_id), None)

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
