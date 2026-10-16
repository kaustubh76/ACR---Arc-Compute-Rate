# ACR deployment references

Addresses supplied by the project author on 2026-10-15. These are reference
contracts, not an execution allowlist. Only the network chain IDs and testnet wallet and token checks
listed below were independently verified; the other contract identities remain
author-supplied. No transactions were signed or submitted.

| Network | Chain ID | RPC | Explorer |
| --- | --- | --- | --- |
| Arc mainnet | 5042 | https://rpc.mainnet.arc.io/ | https://explorer.arc.io/ |
| Arc testnet | 5042002 | https://rpc.testnet.arc.network/ | https://testnet.arcscan.app/ |

| Contract | Mainnet | Testnet |
| --- | --- | --- |
| ACROracle (v1) | `0xAfe8a941957EbD3C759fEA5365fe4B75f9626D07` | `0x4f00e3BDd224F4c4b4958D54cD774E84B9092609` |
| ACROracleV2 | `0xF77E763ef710096c0b9F02Ea16F76e68E0312f81` | `0xFCa038CEad7b9e9aa8fDAfc9e80253835fB8FFEA` |
| SellerRegistry | `0x13CF727d1D25283d58Efe7647dCf30e9cE255096` | `0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7` |
| ACRFutures | `0xdb5D7dbB67aD8EC8517982E95c89906abFBC6d3b` | `0x29d97c629a8278f7ec4218ab0bd8baa9182642fe` |
| FeedAttestor | `0xB9508caD4A5C367C3a62B6767C4837a607EaA490` | `0xe671a8E73900F1186448cFFeA9e730F5E50DFD47` |
| ReceiptMirror | `0x1a5390E59d4ce0a386Aa071365A932Dc34d35bE3` | `0xA9CD5b9503aeA88EB343333E842D2860b263DB65` |
| HumanIdMirror | `0x7134622a01Add334eA306dDa5A5877b418a940B5` | `0x7f41faA38F35F1FABfc76Df5B1618fC8d0c0d8e5` |
| PolicyWallet (current) | `0x3a5F444B0e4Ddc7FA6dcddA07A71d0710eea4e04` (replay-protected; owner hand-over to `0xE804…6dAd` pending `acceptOwnership`) | `0xa67F188746f479A9d93D112BeeB7aadB90bE834b` |
| PolicyWallet (older) | — | `0xA755f87BD00c90DBFc9DdfD6651e4c3071665b32` |

## Treasury compatibility: blocked on a new wallet deployment

Read-only RPC checks on 2026-10-15 confirmed testnet chain ID `5042002`
(starting observed block `67313512`). Both wallets have 5,141 bytes of deployed
runtime code, report `paused() = false`, and bind `usdc()` to
`0x3600000000000000000000000000000000000000`. The token has 1,798 bytes
of runtime code and reports six decimals. The supplied mainnet RPC also
reported chain ID `5042`.

| Wallet | Reported owner | Runtime code keccak256 |
| --- | --- | --- |
| Current | `0x784e6d2d4870174ad1aea3d7446f2377d0c6a05d` | `0x7b7f6a30fd101ed466565e116a7f91fbc0d7f191fdf851e265bdce4088207c92` |
| Older | `0x38dc1b5f05b90ccbe3881aa6490eaa096a619cce` | `0x11c81f7d63449531b599ae5e39d01858ae3b015ad54ead757e1f68977d2d3f47` |

On both wallets, `consumedDecisionHashes(bytes32(0))` reverted with no data.
Neither satisfies this app's replay-protection interface. Preparation must fail
closed; do not bypass that check or enable the current address as a working
payment deployment. Updating backend/app code cannot upgrade these non-proxy
wallets. Deploy the PR's updated PolicyWallet before treasury acceptance.

The author describes the older wallet as the same bytecode, but the observed
runtime hashes differ. Immutable constructor values can produce differences;
these reads do not establish source equivalence.

The generic deployment template intentionally retains placeholders and
`enabled=false`. For the intended testnet deployment, use chain `5042002` and
the verified token address above, but supply a **new replay-protected wallet**,
trusted business slug, and private treasury API origin. The existing oracle,
registry, futures and mirror addresses must not be added to the payment guard.
Mainnet has a replay-protected PolicyWallet since 2026-10-16
(`0x3a5F444B0e4Ddc7FA6dcddA07A71d0710eea4e04`, `consumedDecisionHashes` answers), but the
treasury is not configured on it yet: that needs a mainnet business row, a press image
carrying `/operator/payments*`, and `ACR_TREASURY_*`. See [TREASURY.md](TREASURY.md) for setup and acceptance.
