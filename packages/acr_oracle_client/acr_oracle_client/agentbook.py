"""AgentBook — which wallets act for which verified human.

World's AgentBook lives on World Chain, not Arc, so this is the first reader in
this codebase that points at a second chain. Everything else takes
`rpc_url or settings.arc_rpc_url`; that idiom does not generalise, so AgentBook
gets its own endpoint setting rather than borrowing one that means something else.

OFFLINE-TOLERANT, NOT FAIL-CLOSED — and the difference is not a contradiction.
`humanid.py` refuses to serve a request it could not verify, because admitting an
unverified human is a security failure. This is the other side: reading. An
unreachable AgentBook means the resolver enrolls nobody this run, which is the
same steady state `mirror_receipts.py` treats as success. Refusing to *admit*
without proof and declining to *invent* data when a source is down are the same
discipline, not opposite ones.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from acr_core import get_settings

from .demo_humans import DEMO_HUMANS

log = logging.getLogger("acr_oracle_client.agentbook")


@dataclass(frozen=True)
class Human:
    """One human and the wallets AgentBook says act for them."""

    nullifier: str
    wallets: tuple[str, ...]
    #: A World ID Sandbox identity rather than an Orb-verified person. Carried
    #: all the way to the chain so the tape can be discounted without trusting
    #: whoever ran the resolver.
    sandbox: bool


@runtime_checkable
class AgentBook(Protocol):
    def humans(self) -> list[Human]: ...

    @property
    def source(self) -> str: ...


class FixtureAgentBook:
    """The demo roster. Every human is `sandbox=True`, and cannot be otherwise.

    Not a mock in the testing sense — it is what the demo genuinely runs on, and
    the flag is what keeps that honest rather than hidden.
    """

    source = "fixture"

    def humans(self) -> list[Human]:
        return [
            Human(nullifier=h.nullifier, wallets=tuple(h.wallets), sandbox=True)
            for h in DEMO_HUMANS
        ]


class WorldChainAgentBook:
    """Reads AgentBook on World Chain.

    NOT YET EXERCISED AGAINST A LIVE AGENTBOOK. Sandbox access was still pending
    when this was written, so the one call that touches the chain is isolated in
    `_registrations` and the class is documented as unproven rather than left to
    look tested. Until it lands, a configured book stands down to resolving
    nobody rather than raising through the resolver loop. `sandbox` comes from
    settings here: an Orb-verified deployment sets `ACR_HUMANID_SANDBOX=false`,
    and until it does, claiming otherwise would put an unearned word on the tape.
    """

    source = "world-chain"

    def __init__(self, rpc_url: str | None = None, address: str | None = None, settings=None):
        s = settings or get_settings()
        self.rpc_url = rpc_url or s.world_rpc_url
        self.address = address or (s.agentbook_address or None)
        self.sandbox = s.humanid_sandbox
        self._w3 = None

    def configured(self) -> bool:
        return bool(self.rpc_url and self.address)

    def _connect(self):
        if self._w3 is not None:
            return self._w3
        try:
            from web3 import Web3

            w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 20}))
            self._w3 = w3 if w3.is_connected() else None
        except Exception as exc:  # pragma: no cover - env dependent
            log.warning("AgentBook: web3 unavailable (%s)", exc)
            self._w3 = None
        return self._w3

    def _registrations(self) -> list[tuple[str, str]]:  # pragma: no cover - unexercised
        """(nullifier, wallet) pairs from AgentBook. The one unproven call."""
        raise NotImplementedError(
            "AgentBook's on-chain shape is not settled until Sandbox access lands"
        )

    def humans(self) -> list[Human]:
        if not self.configured() or self._connect() is None:
            log.info("AgentBook offline — resolving nobody this run")
            return []
        try:
            registrations = self._registrations()
        except NotImplementedError as exc:
            # Configured and reachable, but the reader underneath does not exist
            # yet. WARNING rather than info: an outage is not the operator's
            # doing, whereas this state is reached only by setting
            # ACR_WORLD_RPC_URL and ACR_AGENTBOOK_ADDRESS, and nothing else will
            # tell them why a live endpoint enrolled nobody. Standing down is
            # the same steady state an outage produces — declining to invent
            # data when a source is absent, exactly as the module docstring says.
            log.warning("AgentBook reader unavailable — resolving nobody this run (%s)", exc)
            return []
        by_nullifier: dict[str, list[str]] = {}
        for nullifier, wallet in registrations:  # pragma: no cover
            by_nullifier.setdefault(nullifier, []).append(wallet)
        return [
            Human(nullifier=n, wallets=tuple(ws), sandbox=self.sandbox)
            for n, ws in by_nullifier.items()
        ]


def build_agentbook(settings=None) -> AgentBook:
    """The fixture roster unless World Chain is actually configured."""
    s = settings or get_settings()
    if s.world_rpc_url.strip() and s.agentbook_address.strip():
        return WorldChainAgentBook(settings=s)
    return FixtureAgentBook()
