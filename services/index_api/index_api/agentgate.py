"""The gate every agent-to-agent call passes — and the limit that counts people.

Three tiers, and a route is told which one it got rather than left to guess:

    anonymous    no card. Held to the HOST ceiling only, which behind one proxy
                 is a GLOBAL limit and therefore not a per-caller limit at all.
    carded       a valid card. Rate-limited per agent key — better, and still
                 evadable by anyone willing to mint keys, because keys are free.
    human        a card whose claimed cluster MATCHES `HumanIdMirror.clusterOf`
                 on Arc. Rate-limited per HUMAN, so ten keys belonging to one
                 person share one budget.

THE THIRD TIER IS THE POINT. `ratelimit.py` already explains at length why the
host bucket is not a per-person limit: readers arrive through one Vercel proxy, so
every caller in the world shares it. The fix it asks for is an identity — and an
identity that costs nothing to mint does not fix a quota, it renames the problem.
A human does cost something, and this project already measures that on chain.

WHAT A FAILED HUMAN CLAIM MEANS, and why it is a refusal rather than a downgrade.
A card claiming a human it cannot prove is worse than a card claiming none: the
first is a lie the gate would be laundering, the second is an honest anonymous
caller. So a mismatch is 401. But "we could not check" is a THIRD state and must
not be confused with "we checked and it was false" — an unreachable mirror
declines the tier and says so, and never upgrades on the strength of a claim
nobody verified.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from dataclasses import dataclass

from acr_core import get_settings
from acr_oracle_client.agentcard import (
    CARD_DOMAIN_NAME,
    CARD_DOMAIN_VERSION,
    CLOCK_SKEW_S,
    MAX_TTL_S,
    ROLES,
    AgentCard,
    decode_header,
    recover_agent,
)
from acr_oracle_client.humanid import HumanIdMirrorClient, current_window
from fastapi import Header, HTTPException, Request

log = logging.getLogger(__name__)

#: The header an agent presents, and the one a challenge names. Same base64-JSON
#: shape as PAYMENT-SIGNATURE and HUMAN-PROOF — three gates, one decoder for an
#: agent author to write.
CARD_HEADER = "AGENT-CARD"
CHALLENGE_HEADER = "AGENT-CARD-REQUIRED"

TIER_ANON = "anonymous"
TIER_CARDED = "carded"
TIER_HUMAN = "human"


class AgentCardRequired(HTTPException):
    """The 401 a gated route raises when no card is present.

    Carries the same `b64(body)` header shape as the x402 and human-proof
    challenges so a client decodes one envelope everywhere.
    """

    def __init__(self, body: dict) -> None:
        raw = base64.b64encode(
            json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
        ).decode()
        super().__init__(
            status_code=401,
            detail=body,
            headers={"WWW-Authenticate": "AgentCard", CHALLENGE_HEADER: raw},
        )


@dataclass(frozen=True)
class VerifiedAgent:
    """A card that passed, plus what the gate could and could not establish."""

    card: AgentCard
    tier: str
    #: The cluster the chain confirms, never the one the card claimed. None at the
    #: carded tier — and None is "not established", which is why `tier` is the
    #: field a route should branch on rather than this one.
    cluster: str | None = None
    #: Why the human tier was not reached, when a card asked for it. Empty when
    #: nothing was claimed, so "claimed nothing" and "claimed and failed to verify"
    #: are distinguishable.
    human_note: str = ""

    @property
    def ident(self) -> str:
        """The rate-limit key.

        The cluster when the chain confirmed one, the agent address otherwise.
        This single line is what makes minting keys stop buying budget.
        """
        return (self.cluster or self.card.agent).lower()

    @property
    def masked(self) -> str:
        a = self.card.agent
        return f"{a[:6]}…{a[-4:]}" if len(a) > 12 else a


class AgentGate:
    """Verifies a presented card. Stateless apart from counters.

    No nonce table on purpose: the card carries its own bounded window, the same
    trade `AgentKitVerifier` makes. A nonce would buy non-replayability at the
    cost of a round trip before every agent call, which is the cost an agent can
    least afford.
    """

    def __init__(self, settings=None, mirror=None) -> None:
        self.settings = settings or get_settings()
        self._mirror = mirror
        self.verified = 0
        self.human_verified = 0

    # --- configuration ---

    @property
    def audience(self) -> str:
        """Who cards must be addressed to. Defaults to the service's own name
        rather than to a wildcard: a gate that accepts any audience has given up
        the one protection that replaces `verifyingContract`."""
        return (self.settings.agent_audience or "acr-index-api").strip()

    def mirror(self) -> HumanIdMirrorClient:
        if self._mirror is None:
            self._mirror = HumanIdMirrorClient(settings=self.settings)
        return self._mirror

    # --- the challenge ---

    def challenge(self, request: Request) -> AgentCardRequired:
        return AgentCardRequired(
            {
                "error": "agent card required",
                "scheme": "agentcard",
                "header": CARD_HEADER,
                "audience": self.audience,
                "chain_id": int(self.settings.arc_chain_id),
                "domain": {"name": CARD_DOMAIN_NAME, "version": CARD_DOMAIN_VERSION},
                "roles": list(ROLES),
                "max_ttl_seconds": MAX_TTL_S,
                "resource": getattr(getattr(request, "url", None), "path", "") or "",
                # Named so an agent author knows the upgrade exists without
                # reading our source.
                "human_binding": {
                    "field": "human_cluster",
                    "verified_against": "HumanIdMirror.clusterOf",
                    "optional": True,
                },
            }
        )

    # --- verification ---

    def verify(self, request: Request, header: str) -> VerifiedAgent:
        try:
            card, signature = decode_header(header)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail=f"malformed agent card: {exc}") from exc

        # 1 · the signature must recover to the key the card names. Everything
        #     else in the card is a claim BY that key, so this is the only check
        #     whose failure means "you are not who you say".
        try:
            recovered = recover_agent(card, signature, int(self.settings.arc_chain_id))
        except Exception as exc:  # noqa: BLE001 - a malformed sig is a 401, not a 500
            raise HTTPException(status_code=401, detail="agent card signature is unreadable") from exc
        if recovered.lower() != card.agent.lower():
            raise HTTPException(
                status_code=401,
                detail="agent card signature does not match its agent",
            )

        # 2 · audience. This is what stands in for `verifyingContract`: without it
        #     a card minted for another ACR-domain service is presentable here.
        if card.audience.strip().lower() != self.audience.lower():
            raise HTTPException(
                status_code=401,
                detail=f"agent card is addressed to {card.audience!r}, not {self.audience!r}",
            )

        if card.role not in ROLES:
            raise HTTPException(status_code=401, detail=f"unknown role {card.role!r}")

        # 3 · the window, and the BOUND on it. An unbounded card is a permanent
        #     bearer credential for anyone who captures it once.
        now = int(time.time())
        if card.expires_at <= now - CLOCK_SKEW_S:
            raise HTTPException(status_code=401, detail="agent card has expired")
        if card.issued_at > now + CLOCK_SKEW_S:
            raise HTTPException(status_code=401, detail="agent card is not valid yet")
        if card.ttl_s <= 0:
            raise HTTPException(status_code=401, detail="agent card expires before it was issued")
        if card.ttl_s > MAX_TTL_S:
            raise HTTPException(
                status_code=401,
                detail=f"agent card lifetime {card.ttl_s}s exceeds the {MAX_TTL_S}s limit",
            )

        # 4 · the human claim, if one was made.
        cluster, note, tier = None, "", TIER_CARDED
        if card.claims_human:
            cluster, note = self._check_human(card)
            if cluster is not None:
                tier = TIER_HUMAN

        self.verified += 1
        if tier == TIER_HUMAN:
            self.human_verified += 1
        agent = VerifiedAgent(card=card, tier=tier, cluster=cluster, human_note=note)
        log.info("agent card ok %s role=%s tier=%s", agent.masked, card.role, tier)
        return agent

    def _check_human(self, card: AgentCard) -> tuple[str | None, str]:
        """Check the claimed cluster against the chain.

        Returns `(confirmed_cluster, note)`. A None cluster with a note is "not
        established"; the note says which of the three reasons applies, because a
        caller who is told only "no" cannot tell a misconfigured server from a
        false claim from a stale resolution.
        """
        mirror = self.mirror()
        # `readable()`, NOT `configured()`. The latter also demands a signer,
        # because `HumanIdMirrorClient` both reads and writes — and this gate only
        # ever calls `cluster_of`, a view. Gating a read on a write credential put
        # the human tier out of reach on the one deployment that should have it:
        # production, which has no reason to hold a key that can write this mirror.
        if not mirror.readable():
            return None, "the human-id mirror is not configured, so the claim could not be checked"

        window = current_window()
        try:
            got = mirror.cluster_of(card.agent, window)
        except Exception as exc:  # noqa: BLE001 - unreachable chain is not a false claim
            log.warning("agentgate: clusterOf unreadable (%s)", type(exc).__name__)
            return None, "the human-id mirror was unreachable, so the claim could not be checked"

        if got is not None:
            on_chain = "0x" + bytes(got).hex()
            if on_chain.lower() == card.human_cluster.lower():
                return on_chain, ""
            # A mismatch has two quite different causes and the generic message
            # serves neither. Cluster ids are keccak(nullifier, salt, WINDOW), so
            # the same human's id changes completely every 7 days — and the
            # overwhelmingly likely mistake is a card minted against last week's
            # id by an agent that cached it. Measured while building this: the
            # fleet is 0xd9e05794… in window 2957 and 0x5bf3b922… in 2958, with no
            # resemblance between them. Say which mistake it is.
            if card.human_cluster.lower() == self._cluster_hex(card.agent, window - 1):
                raise HTTPException(
                    status_code=401,
                    detail=(
                        f"agent card claims this agent's window {window - 1} cluster id, but the "
                        f"current window is {window} — ids rotate weekly, so re-mint the card "
                        "with the current id"
                    ),
                )
            raise HTTPException(
                status_code=401,
                detail="agent card claims a human cluster the chain does not record for it",
            )

        # Nothing in THIS window. Before calling the claim false, look one window
        # back: cluster ids rotate every 7 days, so a resolution that was valid
        # last week reads identically to a claim that was never true. Telling an
        # operator "re-resolve" instead of "your claim is false" is the whole
        # difference between an actionable 401 and a mysterious one.
        try:
            previous = mirror.cluster_of(card.agent, window - 1)
        except Exception:  # noqa: BLE001 - best-effort diagnosis only
            previous = None
        if previous is not None:
            raise HTTPException(
                status_code=401,
                detail=(
                    f"agent is resolved in window {window - 1} but not {window} — "
                    "cluster ids rotate weekly; re-run the resolver"
                ),
            )
        raise HTTPException(
            status_code=401,
            detail=f"agent is not resolved to any human in window {window}",
        )

    def _cluster_hex(self, agent: str, window: int) -> str:
        """This agent's cluster in `window`, lowercased hex, or "" if none.

        Best-effort and never raises: it exists only to DIAGNOSE a mismatch that
        has already been decided, so an unreachable chain here must degrade to
        the generic message rather than turn a 401 into a 500.
        """
        try:
            got = self.mirror().cluster_of(agent, int(window))
        except Exception:  # noqa: BLE001 - diagnosis only
            return ""
        return ("0x" + bytes(got).hex()).lower() if got else ""

    def info(self) -> dict:
        mirror = self.mirror()
        return {
            "scheme": "agentcard",
            "header": CARD_HEADER,
            "audience": self.audience,
            "chain_id": int(self.settings.arc_chain_id),
            "roles": list(ROLES),
            "max_ttl_seconds": MAX_TTL_S,
            "clock_skew_seconds": CLOCK_SKEW_S,
            "tiers": [TIER_ANON, TIER_CARDED, TIER_HUMAN],
            # Whether the human tier is REACHABLE here. A gate that cannot check
            # claims and one that is granting the tier freely look identical from
            # outside, which is why this is reported rather than described.
            # Whether a claim CAN be checked here — a read, so `readable()`.
            "human_binding_verifiable": mirror.readable(),
            "rotation_window": current_window(),
            "cards_verified": self.verified,
            "human_tier_granted": self.human_verified,
        }


_gate: AgentGate | None = None


def get_gate() -> AgentGate:
    global _gate
    if _gate is None:
        _gate = AgentGate()
    return _gate


def set_gate(gate: AgentGate) -> None:
    global _gate
    _gate = gate


def reset_gate() -> None:
    global _gate
    _gate = None


async def optional_agent(
    request: Request,
    agent_card: str | None = Header(default=None, alias=CARD_HEADER),
) -> VerifiedAgent | None:
    """Same gate, but a missing card is allowed through as anonymous.

    For routes that are public and should stay public: the card UPGRADES the
    caller's rate-limit bucket rather than admitting them. A malformed or lying
    card is still a 401 — presenting a bad card is a different act from presenting
    none, and silently ignoring one would teach agents that the gate is optional
    in a way it is not.
    """
    if agent_card is None:
        return None
    gate = get_gate()
    agent = gate.verify(request, agent_card)
    request.state.agent = agent
    return agent
