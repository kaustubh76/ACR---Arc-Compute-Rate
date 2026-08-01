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


_ledger: FaucetLedger | None = None


def get_ledger() -> FaucetLedger:
    global _ledger
    if _ledger is None:
        _ledger = FaucetLedger()
    return _ledger


def drip_stake(address: str) -> str:
    """Send the 0.5 USDC stake from the custody wallet (the SAME
    CircleWalletSigner path the prod poster uses). Returns the tx hash."""
    if not (address.startswith("0x") and len(address) == 42):
        raise DeskError(400, "not an address")
    ledger = get_ledger()
    ledger.claim(address)
    try:
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
        tx = signer.send_transaction(None, {"to": USDC_PREDEPLOY, "data": calldata})
        log.info("desk faucet: %.2f USDC -> %s (%s)", FAUCET_USDC, address, tx)
        return tx
    except DeskError:
        ledger.release(address)
        raise
    except Exception as exc:
        ledger.release(address)
        log.warning("desk faucet transfer failed for %s: %s", address, exc)
        raise DeskError(502, "stake transfer failed — try again") from exc


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


def build_challenge(
    user_token: str, wallet_id: str, action: str, index_id: str, qty: float = 0.0
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
        contract, sig, params = (
            venue,
            "postCollateral(uint256,uint256)",
            [str(desk["series_id"]), str(int(FAUCET_USDC * 1_000_000))],
        )
    elif action == "trade":
        desk = _live_series(index_id)
        q = max(-MAX_QTY, min(MAX_QTY, float(qty)))
        if q == 0:
            raise DeskError(400, "qty must be non-zero (±1 or ±2)")
        contract, sig, params = (
            venue,
            "trade(uint256,int256)",
            [str(desk["series_id"]), str(int(q * 10**18))],
        )
    else:
        raise DeskError(400, f"unknown action {action!r}")

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
