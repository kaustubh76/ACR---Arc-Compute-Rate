"""AgentBook tests — the roster's shape, and what it refuses to claim."""

from __future__ import annotations

from acr_core.config import ACRSettings
from acr_oracle_client.agentbook import (
    FixtureAgentBook,
    WorldChainAgentBook,
    build_agentbook,
)
from acr_oracle_client.demo_humans import DEMO_HUMANS, DemoBuyer, DemoHuman


def test_the_roster_is_lopsided_on_purpose():
    """One human with several wallets and one with a single wallet.

    With one wallet per human, `distinctHumans` always equals `distinctPayers`,
    the ratio is always 1.0, and nothing shows why grouping wallets by human
    matters — which is the only thing the human-depth component measures.
    """
    book = FixtureAgentBook()
    humans = book.humans()
    assert len(humans) == 2
    sizes = sorted(len(h.wallets) for h in humans)
    assert sizes == [1, 3]
    assert sum(sizes) == 4


def test_every_fixture_human_is_flagged_sandbox():
    """These are derived identities, not people. The flag is what makes having
    them safe — it reaches the chain and the tape, so a rating that counts them
    says how much of its human depth is demo."""
    assert all(h.sandbox for h in FixtureAgentBook().humans())


def test_a_wallet_never_reveals_the_human_behind_it():
    """Wallet keys and nullifiers come from different namespaces on purpose.

    If one were derivable from the other, a public payer address would give up
    the human, and the rotation in HumanIdMirror would be protecting nothing.
    """
    for human in DEMO_HUMANS:
        for label in human.buyers:
            assert DemoBuyer(label).private_key != human.nullifier


def test_the_roster_is_deterministic():
    """Two machines must derive the same addresses, or the resolver enrolls one
    set and the tape shows another."""
    assert FixtureAgentBook().humans() == FixtureAgentBook().humans()


def test_wallets_are_distinct_across_humans():
    seen = [w for h in FixtureAgentBook().humans() for w in h.wallets]
    assert len(seen) == len(set(seen))


def test_nullifiers_are_distinct_across_humans():
    nullifiers = {h.nullifier for h in FixtureAgentBook().humans()}
    assert len(nullifiers) == 2


def test_a_nullifier_is_a_bytes32():
    for h in FixtureAgentBook().humans():
        assert h.nullifier.startswith("0x")
        assert len(h.nullifier) == 66


def test_the_fixture_book_is_used_until_world_chain_is_configured():
    s = ACRSettings(_env_file=None)
    assert isinstance(build_agentbook(s), FixtureAgentBook)


def test_world_chain_is_selected_only_when_both_url_and_address_are_set():
    partial = ACRSettings(_env_file=None, world_rpc_url="https://world.invalid")
    assert isinstance(build_agentbook(partial), FixtureAgentBook)

    full = ACRSettings(
        _env_file=None,
        world_rpc_url="https://world.invalid",
        agentbook_address="0x" + "ab" * 20,
    )
    assert isinstance(build_agentbook(full), WorldChainAgentBook)


def test_an_unreachable_agentbook_resolves_nobody_rather_than_guessing():
    """Offline-tolerant on the READ side. Declining to invent data when a source
    is down is the same discipline as refusing to admit an unverified human —
    not the opposite of it."""
    book = WorldChainAgentBook(
        rpc_url="http://127.0.0.1:1", address="0x" + "ab" * 20,
        settings=ACRSettings(_env_file=None),
    )
    assert book.humans() == []


def test_an_unconfigured_world_book_is_not_configured():
    book = WorldChainAgentBook(
        rpc_url="", address=None, settings=ACRSettings(_env_file=None)
    )
    assert book.configured() is False
    assert book.humans() == []


def test_a_human_with_no_buyers_has_no_wallets():
    assert DemoHuman("nobody", ()).wallets == []
