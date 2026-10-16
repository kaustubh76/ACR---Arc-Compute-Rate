"""Warns: a second decision, from outside, before the agent's own payment.

`decide()` reaches the operator's verdict and `PolicyWallet` holds the limits.
Warns answers a narrower question about the same payment, from a vantage point
this repo does not have: has this agent paid this address before, is the
service asking to be paid somewhere new, and does the payment fit the policies
its workspace set. It holds no key and never touches the contract. The agent
asks it over HTTP and keeps the answer in the record the chain commits to.

THE ORDER, for a payment the ladder has already cleared (`docs/INTEGRATION-WARNS.md`
§3 is the agreement this follows):

    1  ask        POST /v1/decisions, kind "transfer"        -> decisionId
    2  name it    record.warns_decision_id = decisionId      INSIDE the hash
    3  commit     POST /v1/decisions/{id}/commitment         Warns signs that hash
    4  keep it    record.warns_signature                     OUTSIDE the hash
    5  spend      PolicyWallet.spend(..., decisionHash)
    6  report     POST /v1/events/settlement

**We hash, Warns signs.** Nothing here reimplements `decision_hash`: this module
only carries the 32 bytes `policy.decision_hash` produced. §2 of the integration
doc measures why a second implementation would be silently wrong.

OFF UNLESS A KEY IS SET. Without `ACR_WARNS_API_KEY`, `get_warns()` returns
None and the operator pays exactly as it did before. With it, every live
payment the agent makes goes through Warns first, and a Warns that cannot
answer is an escalation rather than a pass. That is the operator's own rule, "a check
that cannot be evaluated is a refusal rather than a pass".

WHAT IT DOES NOT ASK ABOUT, on purpose:

- **Dry runs.** A Warns decision with no payment behind it would sit in their
  dashboard as an allowance nobody used.
- **The owner's own payments** (`spend_as_owner`, from `/ops/actions`). Those
  are the owner's authority, not the agent's. Warns reads them off the `Spent`
  event by `actor` and records an owner payment: alerted, never frozen.
"""

from __future__ import annotations

import hashlib
import logging
import os
import uuid
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

log = logging.getLogger("index_api.warns")

DEFAULT_API = "https://api.warns.xyz"

#: Arc testnet and its USDC: what a client built by hand defaults to. `get_warns`
#: takes the host's own chain instead. A Warns test key decides on Arc testnet.
ARC_TESTNET = "eip155:5042002"
ARC_USDC = "0x3600000000000000000000000000000000000000"

#: The Warns field limits, so a long name is cut here rather than refused there.
_PAYEE_MAX = 64
_INVOICE_MAX = 128


class WarnsUnavailable(RuntimeError):
    """Warns did not answer, or answered something this client cannot read.

    One exception for every way of not getting an answer (a timeout, a 5xx, a
    401 from a revoked key, a body with no outcome), because the operator does
    the same thing with all of them: it pays nothing and escalates.
    """


@dataclass(frozen=True)
class WarnsVerdict:
    """What Warns said about one payment."""

    decision_id: str
    #: ``allow`` · ``review`` · ``block``.
    outcome: str
    #: ``enforced`` in Protect mode. ``shadow`` in Monitor mode, where the
    #: outcome is what Protect would have done and the payment goes ahead.
    enforcement: str
    #: ``({"code": ..., "message": ...}, ...)``, the first one being the reason.
    reasons: tuple[dict, ...] = ()
    #: Set when the payment is held: the item a person approves in Warns.
    review_id: str = ""

    @property
    def enforced(self) -> bool:
        return self.enforcement == "enforced"

    def reason(self) -> str:
        """The first reason, as one line: ``CODE: message``."""
        if not self.reasons:
            return self.outcome
        first = self.reasons[0]
        code = str(first.get("code") or "").strip()
        message = str(first.get("message") or "").strip()
        return f"{code}: {message}" if code and message else (code or message or self.outcome)


def payee_of(resource: str, vendor: str) -> str:
    """Who the payment is to, as Warns should group it.

    The service's host, not the address. Warns learns which addresses each payee
    is paid at, so naming the payee by the address it is paid at would make
    `DESTINATION_CHANGED` ("a service you already paid, asking to be paid
    somewhere new", the swapped-`payTo` case) impossible to raise. A bill with
    no resource has nothing better than the address, and says so by sending none.
    """
    host = urlparse(resource).hostname if resource else None
    return (host or "")[:_PAYEE_MAX]


def idempotency_key(obligation_id: str) -> str:
    """A fresh key per attempt, recognisable per obligation.

    Warns returns the same decision for the same key and body, which makes a
    retry after a dropped connection safe within ONE attempt. A new pass is a
    new attempt: the retry of an approved review needs a new key, or it would
    be handed back the review it is retrying. So the key is never derived from
    the obligation alone.
    """
    stem = hashlib.sha256(obligation_id.encode()).hexdigest()[:16]
    return f"acr-{stem}-{uuid.uuid4().hex[:16]}"


class WarnsClient:
    """The three calls the operator makes. Synchronous, like the rest of the path."""

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        *,
        api_url: str = DEFAULT_API,
        network: str = ARC_TESTNET,
        token: str = ARC_USDC,
        timeout_s: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.network = network
        self.token = token
        self._http = httpx.Client(
            base_url=api_url.rstrip("/"),
            timeout=timeout_s,
            transport=transport,
            headers={"authorization": f"Bearer {api_key}"},
        )

    def _post(self, path: str, body: dict, idem: str | None = None) -> dict:
        headers = {"idempotency-key": idem} if idem else {}
        try:
            r = self._http.post(path, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise WarnsUnavailable(f"{path}: {type(exc).__name__}") from exc
        if r.status_code >= 400:
            # The error code, never the body: an error body can echo the request.
            try:
                code = (r.json().get("error") or {}).get("code")
            except (ValueError, AttributeError):
                code = None
            raise WarnsUnavailable(f"{path}: HTTP {r.status_code}" + (f" {code}" if code else ""))
        try:
            return r.json()
        except ValueError as exc:
            raise WarnsUnavailable(f"{path}: the answer was not JSON") from exc

    def decide(self, *, obligation_id: str, payer: str, to: str, amount_atomic: int,
               payee: str = "", invoice_id: str = "", purpose: str = "") -> WarnsVerdict:
        """Step 1: may this agent send ``amount_atomic`` of USDC from ``payer`` to ``to``?"""
        intent = {
            k: v for k, v in (
                ("payee", payee[:_PAYEE_MAX]),
                ("invoiceId", invoice_id[:_INVOICE_MAX]),
                ("purpose", purpose[:256]),
            ) if v
        }
        body = {
            "kind": "transfer",
            "agentId": self.agent_id,
            # The PolicyWallet pays, not the agent's key: it is the address the
            # tokens leave from and the one registered on the Warns agent.
            "payer": payer,
            "network": self.network,
            "token": self.token,
            "to": to,
            "amountAtomic": str(int(amount_atomic)),
            **({"intent": intent} if intent else {}),
        }
        data = self._post("/v1/decisions", body, idem=idempotency_key(obligation_id))
        outcome = str(data.get("outcome") or "")
        decision_id = str(data.get("decisionId") or "")
        if outcome not in ("allow", "review", "block") or not decision_id:
            raise WarnsUnavailable("/v1/decisions: no outcome in the answer")
        return WarnsVerdict(
            decision_id=decision_id,
            outcome=outcome,
            enforcement=str(data.get("enforcement") or "enforced"),
            reasons=tuple(r for r in (data.get("reasons") or []) if isinstance(r, dict)),
            review_id=str(data.get("reviewId") or ""),
        )

    def commit(self, decision_id: str, decision_hash: bytes) -> str:
        """Step 3: Warns signs the hash of the record that names its decision.

        Returns the signature (``commitment``), which goes on the record OUTSIDE
        what is hashed. Only an allowed decision can be committed to, within 15
        minutes of it, and one decision names one record.
        """
        if len(decision_hash) != 32:
            raise ValueError("a decision hash is 32 bytes")
        data = self._post(
            f"/v1/decisions/{decision_id}/commitment",
            {"decisionHash": "0x" + decision_hash.hex()},
        )
        commitment = str(data.get("commitment") or "")
        if not commitment:
            raise WarnsUnavailable("commitment: no signature in the answer")
        return commitment

    def report(self, decision_id: str, tx: str | None, success: bool) -> bool:
        """Step 6: tell Warns the payment happened, or that it did not.

        NEVER RAISES. By the time this runs the money has moved or failed to,
        and a reporting error must not turn a payment into an exception the
        keeper counts as a failure. Warns reads the `Spent` event anyway and
        matches it by hash; the report is what releases the budget it reserved
        when a payment failed, and what makes a success show up at once.
        """
        body = {"decisionId": decision_id, "success": bool(success), "network": self.network}
        # Only a chain transaction hash. A Circle signer can hand back its own
        # transaction id instead, and that names nothing Warns could look up.
        if tx and str(tx).startswith("0x") and len(str(tx)) == 66:
            body["transaction"] = str(tx)
        try:
            self._post("/v1/events/settlement", body)
            return True
        except WarnsUnavailable as exc:
            log.warning("warns: the settlement report for %s failed (%s)", decision_id, exc)
            return False


def get_warns(business: str = "") -> WarnsClient | None:
    """The client for one business, or None when Warns is not configured.

    Built per call and never cached, for the reason `operator_keeper` builds its
    policy client per pass: the agent id is per business, and a cached client
    keeps deciding for a business whose configuration changed.

    ``ACR_WARNS_AGENT_ID`` may name ``{business}``, so one key serves one Warns
    agent per business wallet; unset, the agent id IS the business slug.

    THE NETWORK IS THE ONE THIS HOST PAYS ON, read from the same settings the
    wallet is, never a constant. A mainnet host asking about a testnet payment
    would get an answer about a payment that is not the one being sent.
    """
    key = (os.environ.get("ACR_WARNS_API_KEY") or "").strip()
    if not key:
        return None
    from acr_core import get_settings

    s = get_settings()
    template = (os.environ.get("ACR_WARNS_AGENT_ID") or "{business}").strip()
    agent_id = template.replace("{business}", business or "default")
    return WarnsClient(
        key,
        agent_id,
        api_url=(os.environ.get("ACR_WARNS_API_URL") or DEFAULT_API).strip(),
        network=(os.environ.get("ACR_WARNS_NETWORK") or s.caip2()).strip(),
        token=(os.environ.get("ACR_WARNS_TOKEN") or s.usdc_address).strip(),
        timeout_s=float(os.environ.get("ACR_WARNS_TIMEOUT_S") or "10"),
    )
