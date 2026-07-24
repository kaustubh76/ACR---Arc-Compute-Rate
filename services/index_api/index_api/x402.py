"""x402 payment gate — the self-referential business model.

The index about machine commerce is bought BY machines. Every gated query is
behind an HTTP 402 Payment Required: an agent presents an x402 payment header,
the facilitator verifies (and settles) it, and the data is served. Every paid
query is simultaneously revenue and a Nanopayments dogfooding datapoint.

Two facilitators, selected by config:
  * ``DevFacilitator`` (default) — accepts a well-formed mock header
    ``x402 <payer>:<amount>`` so the loop is demonstrable offline.
  * ``CircleFacilitator`` — real x402 v2: returns a base64 ``PAYMENT-REQUIRED``
    (a PaymentRequirements object, ``exact``/GatewayWalletBatched scheme on Arc),
    then on retry POSTs the ``PAYMENT-SIGNATURE`` payload to the Circle Gateway
    facilitator's ``POST /v1/x402/verify`` + ``/v1/x402/settle`` and gates on
    the result. Fail-closed: any error → 402 (never serve unpaid).

Both facilitators raise the challenge as a :class:`PaymentRequired` carrying
the Gateway-shaped ``{"x402Version": 2, "resource": {...}, "accepts": [...]}``
JSON body — what x402 client SDKs parse (``x402Version`` MUST be 2 and
``resource`` MUST be an object, or Circle's Gateway API rejects the payload
shape) — which ``app.py`` renders via an exception handler. The legacy
``X-402-*`` / base64 ``PAYMENT-REQUIRED`` headers are kept alongside (the
Terminal console reads them).
"""

from __future__ import annotations

import base64
import json
import logging
import math
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass

from acr_core import get_settings
from fastapi import Header, HTTPException, Request, Response

log = logging.getLogger("index_api.x402")

USDC_DECIMALS = 6
#: Dev pay-to address (a valid checksummed dummy — the live seller wallet comes
#: from ACR_X402_PAY_TO).
PAY_TO = "0xACacE0000000000000000000000000000000CafE"
NETWORK = "arc-testnet"
ASSET = "USDC"


def price_usdc() -> float:
    """Per-query price in USDC (sub-cent — a Nanopayment). ``ACR_X402_PRICE_USDC``."""
    return get_settings().x402_price_usdc


def atomic_amount(price: float) -> str:
    """A USDC price as an atomic-unit decimal string (6 decimals).

    A positive sub-atomic price (< 1e-6) advertises 1 unit rather than "0" —
    an advertised zero the gate then rejects would strand every buyer.
    """
    atomic = int(round(price * 10**USDC_DECIMALS))
    if atomic == 0 and price > 0:
        atomic = 1
    return str(atomic)


class PaymentRequired(Exception):
    """The 402 challenge: spec-shaped JSON body + x402 headers.

    Raised by ``require_payment`` when no payment header is present; the app's
    exception handler renders ``body`` as the JSON response, so x402 client
    SDKs (which parse the top-level ``accepts`` array) and header-reading
    clients (the Terminal console decodes ``PAYMENT-REQUIRED``) both work.
    """

    status_code = 402

    def __init__(self, body: dict, headers: dict[str, str]) -> None:
        super().__init__("Payment Required")
        self.body = body
        self.headers = headers


def build_payment_requirements(resource: str, settings=None) -> dict:
    """One x402 PaymentRequirements object for ``resource``.

    Emits BOTH ``maxAmountRequired`` (the x402 v1 key) and ``amount`` (v2) with
    the same atomic value, so parsers of either vintage find their field.
    Shared by the facilitator challenges and the /marketplace/catalog listings.
    """
    s = settings or get_settings()
    amount = atomic_amount(s.x402_price_usdc)
    return {
        "scheme": s.x402_scheme,
        "network": s.caip2(),
        "asset": s.usdc_address,
        "payTo": s.x402_pay_to or PAY_TO,
        "maxAmountRequired": amount,
        "amount": amount,
        "resource": resource,
        "description": "ACR machine-commerce index query",
        "mimeType": "application/json",
        "maxTimeoutSeconds": s.x402_max_timeout_seconds,
        # Verified against @circle-fin/x402-batching v3: the buyer SDK selects
        # the option where extra == {name: "GatewayWalletBatched", version: "1",
        # verifyingContract: <GatewayWallet>} and signs EIP-3009 against that
        # verifyingContract (not the USDC token).
        "extra": {
            "name": "GatewayWalletBatched",
            "version": "1",
            "verifyingContract": s.x402_gateway_wallet,
        },
    }


def facilitator_endpoint(base: str, name: str) -> str:
    """Join the facilitator base URL with the Gateway x402 API path.

    Circle's facilitator lives under ``/v1/x402`` (``POST /v1/x402/verify``,
    ``POST /v1/x402/settle``); a base that already ends there is used as-is, so
    both ``https://gateway-api-testnet.circle.com`` and a full ``…/v1/x402``
    base work.
    """
    b = base.rstrip("/")
    if not b.endswith("/v1/x402"):
        b = f"{b}/v1/x402"
    return f"{b}/{name}"


def _resource_for(request: Request, settings) -> str:
    return (settings.x402_resource_base or str(request.base_url).rstrip("/")) + request.url.path


def _resource_object(request: Request, settings) -> dict:
    """The challenge envelope's top-level ``resource`` — an OBJECT, not a string.

    Circle's Gateway x402 API requires ``paymentPayload.resource`` to be an object;
    the buyer SDK copies ``paymentRequired.resource`` verbatim into the payload it
    signs, so this shape must match ``{url, description, mimeType}`` (verified
    against @circle-fin/x402-batching's own server middleware).
    """
    return {
        "url": _resource_for(request, settings),
        "description": "ACR machine-commerce index query",
        "mimeType": "application/json",
    }


def _challenge_body(requirements: dict, resource: dict) -> dict:
    # x402Version MUST be 2 and `resource` MUST be an object — Circle's Gateway API
    # rejects a v1 envelope / string resource before it ever checks the signature.
    return {
        "x402Version": 2,
        "error": "payment required",
        "resource": resource,
        "accepts": [requirements],
    }


@dataclass
class PaymentReceipt:
    payer: str
    amount_usdc: float
    tx_ref: str
    network: str = ""
    scheme: str = ""


class Facilitator(ABC):
    """Base gate: bounded counters + the challenge/process seam ``require_payment``
    calls. Counters are a running total + a small ring of recent receipts, so a
    long-lived process serving sustained agent traffic does not leak memory."""

    def __init__(self) -> None:
        self.paid_queries = 0
        self._revenue = 0.0
        self.recent: deque[PaymentReceipt] = deque(maxlen=256)

    @property
    def revenue_usdc(self) -> float:
        return self._revenue

    def _record(self, receipt: PaymentReceipt) -> PaymentReceipt:
        self.paid_queries += 1
        self._revenue += receipt.amount_usdc
        self.recent.append(receipt)
        return receipt

    @abstractmethod
    def challenge(self, request: Request) -> PaymentRequired:
        """The 402 to raise when no payment header is present."""

    @abstractmethod
    async def process(self, request: Request, header: str, response: Response) -> PaymentReceipt:
        """Verify (and, live, settle) a presented payment; raise 402 if invalid."""


def _b64(obj: dict) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


class DevFacilitator(Facilitator):
    """Dev-mode gate — accepts a mock ``x402 <payer>:<amount>`` header. No chain."""

    def challenge(self, request: Request) -> PaymentRequired:
        s = get_settings()
        body = _challenge_body(
            build_payment_requirements(_resource_for(request, s), s), _resource_object(request, s)
        )
        return PaymentRequired(
            body=body,
            headers={
                "WWW-Authenticate": "x402",
                "X-402-Price": f"{s.x402_price_usdc}",
                "X-402-Asset": ASSET,
                "X-402-Network": NETWORK,
                "X-402-Pay-To": PAY_TO,
                # Same envelope as the JSON body — buyer SDKs (GatewayClient)
                # parse the header, not the body.
                "PAYMENT-REQUIRED": _b64(body),
            },
        )

    async def process(self, request: Request, header: str, response: Response) -> PaymentReceipt:
        try:
            scheme, rest = header.split(" ", 1)
            payer, amount = rest.split(":", 1)
            amt = float(amount)
        except Exception as exc:
            raise HTTPException(status_code=402, detail="malformed x402 payment") from exc
        if scheme.lower() != "x402":
            raise HTTPException(status_code=402, detail="unsupported payment scheme")
        # isfinite: "nan"/"inf" parse as floats, defeat the >= check (NaN
        # comparisons are all False), and a recorded non-finite amount poisons
        # the revenue counter — Starlette's JSON encoder then 500s /revenue.
        if not math.isfinite(amt) or amt + 1e-12 < price_usdc():
            raise HTTPException(status_code=402, detail="insufficient payment")
        # tx_ref numbered AFTER the increment inside _record, so dev-N matches
        # the public ledger's seq N. Network is CAIP-2 like every other surface
        # (catalog, /x402/info) — only the legacy X-402-Network header keeps the
        # human "arc-testnet" name.
        net = get_settings().caip2()
        receipt = self._record(
            PaymentReceipt(payer=payer, amount_usdc=amt, tx_ref=f"dev-{self.paid_queries + 1}",
                           network=net, scheme="dev")
        )
        # Same confirmation headers as the live gate, so buyer code decodes one
        # shape in both modes.
        confirmation = _b64(
            {"success": True, "transaction": receipt.tx_ref, "network": net,
             "payer": receipt.payer}
        )
        response.headers["PAYMENT-RESPONSE"] = confirmation
        response.headers["X-PAYMENT-RESPONSE"] = confirmation
        return receipt


class CircleFacilitator(Facilitator):
    """Real x402 v2 gate against a Circle Gateway facilitator (verify + settle)."""

    def __init__(self, http_client=None, settings=None) -> None:
        super().__init__()
        self.settings = settings or get_settings()
        self._http = http_client  # injectable httpx.AsyncClient for tests

    def payment_requirements(self, request: Request) -> dict:
        return build_payment_requirements(_resource_for(request, self.settings), self.settings)

    def challenge(self, request: Request) -> PaymentRequired:
        # The b64 header carries the FULL {x402Version, accepts} envelope:
        # verified against @circle-fin/x402-batching v3, whose pay() decodes
        # PAYMENT-REQUIRED and reads `.accepts` (it never parses the body).
        body = _challenge_body(
            self.payment_requirements(request), _resource_object(request, self.settings)
        )
        return PaymentRequired(
            body=body,
            headers={
                "WWW-Authenticate": "x402",
                "PAYMENT-REQUIRED": _b64(body),
            },
        )

    # --- confirmed Gateway x402 API response shapes ---
    @staticmethod
    def _parse_verify(payload: dict) -> tuple[bool, str]:
        """``POST /v1/x402/verify`` → ``{isValid, invalidReason, payer}``."""
        return bool(payload.get("isValid")), str(payload.get("invalidReason") or "")

    @staticmethod
    def _parse_settle(payload: dict) -> tuple[bool, str, str, str]:
        """``POST /v1/x402/settle`` → ``{success, transaction, network, payer}``
        on success, ``{success: false, errorReason, …}`` on failure."""
        return (
            bool(payload.get("success")),
            str(payload.get("transaction") or ""),
            str(payload.get("network") or ""),
            str(payload.get("errorReason") or ""),
        )

    async def process(self, request: Request, header: str, response: Response) -> PaymentReceipt:
        reqs = self.payment_requirements(request)
        try:
            payload = json.loads(base64.b64decode(header))
        except Exception as exc:
            raise HTTPException(status_code=402, detail="malformed PAYMENT-SIGNATURE") from exc

        body = {"paymentPayload": payload, "paymentRequirements": reqs}
        base = self.settings.x402_facilitator_url
        try:
            client, owns = self._http, False
            if client is None:  # pragma: no cover - live path builds its own client
                import httpx

                client = httpx.AsyncClient(timeout=self.settings.x402_max_timeout_seconds)
                owns = True
            try:
                vr = await client.post(facilitator_endpoint(base, "verify"), json=body)
                valid, invalid_reason = self._parse_verify(vr.json())
                if not valid:
                    # Surface Circle's real reason in the server log — a bare 402
                    # reaching the buyer SDK collapses to "Payment Required".
                    log.warning("x402 verify rejected (HTTP %s): %s", vr.status_code, vr.text[:300])
                    raise HTTPException(
                        status_code=402,
                        detail=f"payment invalid: {invalid_reason or 'unspecified'}"[:160],
                    )
                sr = await client.post(facilitator_endpoint(base, "settle"), json=body)
                settle = sr.json()
                ok, tx, network, error_reason = self._parse_settle(settle)
                if not ok:
                    log.warning("x402 settle rejected (HTTP %s): %s", sr.status_code, sr.text[:300])
                    raise HTTPException(
                        status_code=402,
                        detail=f"settlement failed: {error_reason or 'unspecified'}"[:160],
                    )
            finally:
                if owns:  # pragma: no cover - live path
                    await client.aclose()
        except HTTPException:
            raise
        except Exception as exc:  # network/timeout/etc → fail closed
            log.warning("x402 facilitator error: %s", exc)
            raise HTTPException(status_code=402, detail="facilitator unavailable") from exc

        # The settle response's payer is authoritative (recovered from the
        # signature); the payload fields are a fallback for older facilitators.
        payer = str(settle.get("payer") or payload.get("from") or payload.get("payer") or "")
        receipt_network = network or reqs["network"]
        confirmation = _b64(
            {"success": True, "transaction": tx, "network": receipt_network, "payer": payer}
        )
        response.headers["PAYMENT-RESPONSE"] = confirmation
        response.headers["X-PAYMENT-RESPONSE"] = confirmation
        return self._record(
            PaymentReceipt(payer=payer, amount_usdc=self.settings.x402_price_usdc, tx_ref=tx,
                           network=receipt_network, scheme=reqs["scheme"])
        )


# --- module singleton + selection (mirrors onchain.get_reader / reset_reader) ---
_facilitator: Facilitator | None = None


def get_facilitator() -> Facilitator:
    global _facilitator
    if _facilitator is None:
        s = get_settings()
        mode = s.x402_mode.strip().lower()
        if mode == "dev":
            _facilitator = DevFacilitator()
        elif mode == "circle":
            # Explicit circle mode without config still fails closed: every
            # process() error is a 402, never an unpaid serve.
            if not (s.x402_facilitator_url and s.x402_pay_to):
                log.warning("x402_mode=circle but facilitator URL/pay-to unset — will fail closed")
            _facilitator = CircleFacilitator(settings=s)
        else:  # auto — Circle only if the URL + pay-to actually look real
            url, pay_to = s.x402_facilitator_url.strip(), s.x402_pay_to.strip()
            use_circle = url.startswith("http") and pay_to.startswith("0x")
            _facilitator = CircleFacilitator(settings=s) if use_circle else DevFacilitator()
    return _facilitator


def set_facilitator(fac: Facilitator) -> None:
    """Install a facilitator (tests inject a CircleFacilitator wired to a mock)."""
    global _facilitator
    _facilitator = fac


def reset_facilitator() -> None:
    global _facilitator
    _facilitator = None


async def require_payment(
    request: Request,
    response: Response,
    payment_signature: str | None = Header(default=None, alias="PAYMENT-SIGNATURE"),
    x_payment: str | None = Header(default=None, alias="X-Payment"),
) -> PaymentReceipt:
    """FastAPI dependency: 402 unless a valid x402 payment is present. Accepts the
    canonical ``PAYMENT-SIGNATURE`` header or the legacy ``X-Payment``."""
    fac = get_facilitator()
    header = payment_signature or x_payment
    if header is None:
        raise fac.challenge(request)
    receipt = await fac.process(request, header, response)
    request.state.payment = receipt
    log.info("x402 settled %s paid $%.4f (%s)", receipt.payer, receipt.amount_usdc, receipt.tx_ref)
    return receipt
