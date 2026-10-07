"""The rotation window, pinned across the three places that implement it.

A human cluster id is `keccak256(nullifier, salt, window)`. Three independent
implementations compute that `window` and they must agree exactly:

  * `HumanIdMirror.RATING_WINDOW` decides which window a resolution may be
    recorded for,
  * `RATING_WINDOW` in `graph/src/parties.ts` decides which window a settlement
    looks for a cluster in,
  * `RATING_WINDOW_S` in `index_api.tca` decides which window a seller rating
    reads its distinct-human count from.

If they drift, nothing raises. The mapping looks for a cluster in a window the
resolver never wrote one for, every payer silently reads as non-human, the
`human_depth` component reports "no human resolutions on the tape" — and the
number that says how many verified humans secure the benchmark quietly becomes
zero while every test that mocks its own data still passes.

The repo already answers this class of problem by reading the other
implementation off disk rather than restating it: `apps/terminal/lib/chain.test.ts`
reads `ACRFutures.sol` for `MAX_SETTLE_AGE`, and `test_parity_onchain.py` runs one
vector through two implementations. This is the same move.
"""

from __future__ import annotations

import re
from pathlib import Path

from acr_oracle_client.humanid import cluster_id, salt_commitment
from index_api.tca import RATING_WINDOW_DAYS, RATING_WINDOW_S

ROOT = Path(__file__).resolve().parents[1]
SOLIDITY = ROOT / "contracts/src/HumanIdMirror.sol"
MAPPING = ROOT / "graph/src/parties.ts"
FORGE_TEST = ROOT / "contracts/test/HumanIdMirror.t.sol"

#: Solidity time units, so `7 days` is read as the contract reads it.
_UNITS = {"seconds": 1, "minutes": 60, "hours": 3600, "days": 86400, "weeks": 604800}


def _solidity_window() -> int:
    src = SOLIDITY.read_text()
    m = re.search(
        r"uint64\s+public\s+constant\s+RATING_WINDOW\s*=\s*(\d+)\s*(\w+)?\s*;", src
    )
    assert m, "RATING_WINDOW not found in HumanIdMirror.sol — has it been renamed?"
    value, unit = int(m.group(1)), (m.group(2) or "seconds")
    assert unit in _UNITS, f"unhandled Solidity time unit {unit!r}"
    return value * _UNITS[unit]


def _mapping_window() -> int:
    src = MAPPING.read_text()
    m = re.search(r"RATING_WINDOW\s*=\s*BigInt\.fromI32\((\d+)\)", src)
    assert m, "RATING_WINDOW not found in graph/src/parties.ts — has it been renamed?"
    return int(m.group(1))


def test_the_contract_and_the_mapping_agree_on_the_window() -> None:
    assert _solidity_window() == _mapping_window()


def test_the_api_agrees_with_the_contract() -> None:
    assert RATING_WINDOW_S == _solidity_window()


def test_the_window_is_a_whole_number_of_days() -> None:
    # The rating window is expressed in days everywhere it is shown to a reader,
    # and `SellerDay` buckets are daily. A window that did not divide evenly into
    # days would make "7d" a rounding rather than a fact.
    assert RATING_WINDOW_S % 86400 == 0
    assert RATING_WINDOW_DAYS == RATING_WINDOW_S // 86400


# --- the cluster id itself ----------------------------------------------------
# The window is only half of it. `clusterId = keccak256(abi.encode(nullifier,
# salt, window))` is computed off chain by BOTH the API (from a verified proof)
# and the resolver (when it records a wallet). Nothing on chain can check that
# arithmetic, because the contract must never see a nullifier — so a drift
# between the two would be silent: the API would look up a cluster the resolver
# never wrote, and every human would read as unresolved rather than as an error.
#
# The forge suite computes the same vector in Solidity. This reads its expected
# value off disk and asserts Python agrees, so a change to either side turns one
# of the two tests red.


def _vector() -> dict[str, str]:
    src = FORGE_TEST.read_text()
    out: dict[str, str] = {}
    for name in ("PARITY_NULLIFIER", "PARITY_SALT", "PARITY_CLUSTER_ID"):
        m = re.search(rf"{name}\s*=\s*(0x[0-9a-fA-F]{{64}})", src)
        assert m, f"{name} not found in HumanIdMirror.t.sol — has the vector moved?"
        out[name] = m.group(1)
    m = re.search(r"PARITY_WINDOW\s*=\s*(\d+)", src)
    assert m, "PARITY_WINDOW not found in HumanIdMirror.t.sol"
    out["PARITY_WINDOW"] = m.group(1)
    return out


def test_python_derives_the_same_cluster_id_as_solidity() -> None:
    v = _vector()
    got = cluster_id(v["PARITY_NULLIFIER"], v["PARITY_SALT"], int(v["PARITY_WINDOW"]))
    assert "0x" + got.hex() == v["PARITY_CLUSTER_ID"].lower()


def test_python_derives_the_same_salt_commitment_as_solidity() -> None:
    v = _vector()
    src = FORGE_TEST.read_text()
    m = re.search(r"keccak256\(abi\.encode\(PARITY_SALT\)\),\s*(0x[0-9a-fA-F]{64})", src)
    assert m, "the salt-commitment vector is not in HumanIdMirror.t.sol"
    assert "0x" + salt_commitment(v["PARITY_SALT"]).hex() == m.group(1).lower()


def test_the_encoding_is_abi_encode_not_encode_packed() -> None:
    """`solidity_keccak` would pack the uint64 into 8 bytes instead of 32.

    It fails in the hardest way to notice: consistently, and only against the
    chain. This asserts the two encodings genuinely differ, so the test above is
    actually discriminating rather than passing for both.
    """
    from web3 import Web3

    v = _vector()
    n = bytes.fromhex(v["PARITY_NULLIFIER"][2:])
    s = bytes.fromhex(v["PARITY_SALT"][2:])
    w = int(v["PARITY_WINDOW"])
    packed = Web3.solidity_keccak(["bytes32", "bytes32", "uint64"], [n, s, w])
    assert bytes(packed) != cluster_id(n, s, w)
