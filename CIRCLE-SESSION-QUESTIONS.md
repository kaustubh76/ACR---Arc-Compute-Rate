# Circle × Arc session — ACR's questions

> Session: Ignyte × Circle × Arc live build on autonomous agents (Agent Stack,
> Gateway/x402 nanopayments, wallet guardrails, open Q&A).
> Position to open from: **we're not asking how to start — every rail on your
> agenda already runs in our production stack.** 7 real Gateway x402
> settlements on a public ledger, a live cash-settled futures venue on Arc,
> readers trading through Circle user-controlled SCA wallets from a browser,
> paymaster-sponsored gas, custody-signed hourly oracle prints, and measured
> numbers on Arc's RPC edges.

---

## Tier 1 — the five headline questions (ask no matter what)

### Q1. Platform-enforced spend policies for agent-held wallets

> "Our buyer agent settles real x402 payments autonomously, but its only
> guardrail is a client-side spend cap in its own code, and its key lives in
> CI secrets. Does the Agent Stack support **declarative, platform-enforced
> policies** on developer-controlled wallets — per-resource caps, velocity
> limits, counterparty allowlists — so an agent can hold signing power but
> *physically cannot* overspend, even if its code is wrong?"

- **Why it wins:** "the agent's budget is enforced by the platform, not by
  the agent's own honesty" is *the* unsolved problem of autonomous payments —
  and we hit it in production, not in a slide.
- **If yes, we ship:** maker/taker/buyer keys move into Circle custody under
  policy; the raw-EOA-in-secrets model is retired. Pitch line: *no private
  key exists in our repo, anywhere.*

### Q2. Delegated autonomy on user-controlled wallets — the auto-hedger

> "On our Public Desk, humans open Circle user-controlled SCA wallets via the
> PIN ceremony and trade our compute futures. Can a user grant a
> **time-boxed, amount-boxed session credential** so an agent trades *on
> their behalf* — 'hedge my compute bill, up to 10 USDC, this week' — without
> a PIN per transaction? What's the supported path on Arc today: session keys
> on the SCA, a policy-bound developer wallet per user, or roadmap?"

- **Why it wins:** this closes our deck's lead use case (the compute-cost
  hedger) end-to-end as an *autonomous* flow. Human sets a mandate once, the
  agent executes within it — human-delegated autonomy is rarer and more
  novel than human-absent autonomy.
- **If yes, we ship:** an "auto-hedger" mode on the Desk using whatever
  primitive they name. Even their fallback answer demos within the week.

### Q3. Arc is not in your own Discovery API — what is the path?

> "Your Discovery API serves **958 listings**, and every network in a 200-item
> sample is a mainnet chain — Base, Ethereum, Polygon, Avalanche, Arbitrum,
> Optimism, Unichain, Sonic, World Chain, Sei, Hyperliquid.
> `network=eip155:5042002` returns **zero**, and no Arc network appears
> anywhere. We meet every listing prerequisite — 402 when unpaid, we serve on
> payment, we publish an OpenAPI spec, and our payout wallet is a Circle
> developer-controlled wallet — so the only thing disqualifying us is the
> chain. **What is the path for an Arc service to become discoverable, and does
> it change when Arc mainnet lands?**"

**Why it wins:** it is a question only someone who ran the query can ask, and it
lands on a real gap in their own stack — the chain they built for agents is the
one their agent marketplace cannot index. Everyone else in the room will ask
"how do I get listed"; this asks "why can nothing on Arc be listed".

**Follow-ups worth having ready:**
- Your seller-integration-tools page points at Proceeds "on Arc and other
  blockchains" — is that the sanctioned route for Arc services today, and does
  it cover testnet?

  > **Measured 2026-08-04 — half-answered, and the remaining half is sharper.**
  > Technically yes: their management API
  > (<https://myproceeds.xyz/api/openapi.yaml>) carries **`arc-testnet`** as a
  > first-class `NetworkId`, accepts a `mode: testnet` service, and its
  > `Transaction.scheme` even includes **`nano` — "Circle Gateway batching"**.
  > But Proceeds is a **paying proxy**: the buyer pays *them*, and they call my
  > origin carrying a static bearer token from the service's `authConfig`. So
  > the real question is no longer "can an Arc service be listed" but **"is a
  > proxy the sanctioned shape?"** — because taking that route means my gate
  > admits a forwarded call on a shared secret instead of an on-chain
  > settlement, which is a strictly weaker guarantee than x402 settling to my
  > own wallet. Related: `PaywallCreate` has no `merchantWallet` field, so a new
  > paywall pays *their* embedded wallet until it is PATCHed — a default worth
  > flagging to any seller you point there. We declined the listing for those
  > reasons; ask this in the reply to the marketplace form.
- Is `x402Version: 2` a hard requirement for indexing? (Ours advertised 1 until
  we diffed against a live listing; nothing documented the version.)
- `FINANCIAL_ANALYSIS` carries 447 of the 958. Is the six-category taxonomy
  fixed, and how does a genuinely new category get added?

**What we ship either way:** our catalog now matches your item shape exactly —
`x402Version: 2`, `lastUpdated`, and a `metadata.provider` carrying the
`category`/`tags`/`website`/`docsUrl` your API filters on — verified by diffing
a built item against a live `FINANCIAL_ANALYSIS` listing. Plus the field no
other listing has: an on-chain attestation anchor, so a cautious agent can
require an attested seller before it pays.

### Q4. Pay-from-anywhere via Gateway's unified balance

> "Our payer deposited USDC into GatewayWalletBatched on Arc and settles
> there. Gateway's design is a **cross-chain unified USDC balance** — can a
> buyer holding testnet USDC on Base or Ethereum settle an x402 challenge
> whose seller expects Arc, with Gateway handling the rebalance? What's the
> supported chain set on testnet today?"

- **Why it wins:** it converts every judge into a potential live buyer —
  fund from whatever testnet USDC you already hold. And cross-chain/CCTP is
  the **only Circle rail ACR doesn't use yet** (verified: zero references in
  our code), so it's the final week's genuine expansion.
- **If yes, we ship:** a "fund from any chain" path for the buyer agent and
  Desk funding.

### Q5. Event push instead of log polling — with our measured numbers

> "We measured Arc's read path hard: `eth_getLogs` 413s above a ~15,000-block
> range, rejects a string `toBlock` (-32602), and 429-throttles aggressively —
> our tape reader pages 4 × 14,000 blocks and has to distinguish throttling
> from range errors, because backing off the range on a 429 silently
> destroys read reach. We already verify Circle webhooks for wallet events.
> Is there a supported **event-subscription / webhook path for Arc contract
> events**, or a higher-tier RPC / indexer for testnet?"

- **Why it wins:** nobody else in the room will have these numbers. It marks
  us as the team that found the platform's real edges — exactly the
  "integration issues" conversation they invited.
- **If yes, we ship:** the futures tape moves to push; the pager retires.

---

## Tier 2 — backups, one per theme (Q&A round two, hallway)

### Q6. The economic floor of nanopayments
At $0.0001/query, what does a Gateway settlement actually cost on your side —
and is **streaming / metered settlement** (pay-per-second data subscription
instead of a 402 round trip per request) on the roadmap? A metered channel
would make our index feed *subscribable* by an agent rather than re-bought
per query.

### Q7. Receipts as on-chain rights — ASKED, ANSWERED, SHIPPED ✅

**Asked at the session:** can a smart contract verify a Gateway settlement — an
attestation or signature checkable on-chain?

**Circle's answer:** *"For Gateway settlements, you'd need an EIP-712 signed
attestation or oracle receipt to cryptographically verify the off-chain x402
payment on-chain for the rebate."*

**So we built it, the same day.** `FeedAccessAttestor`
[`0xe671a8E7…`](https://testnet.arcscan.app/address/0xe671a8E73900F1186448cFFeA9e730F5E50DFD47)
on Arc: the seller signs a `FeedAccess` struct with the **same Circle custody
wallet that signs oracle prints**, anyone may relay it, and the contract
recovers the signer with `ecrecover` — exactly the pattern `ACROracle` already
uses, so the trust anchor is one a judge has already verified.

Proven live: the hedger's 3 settlements were attested to its smart account and
`hasFeedAccess(0x1Dc707E3…)` returns **true**. Off-chain revenue is now an
on-chain right.

The design decision worth defending: the seller **signs**, it does not
**decide**. Every attestation is derived from rows already public at
`/marketplace/receipts`, so it cannot mint access nobody paid for — that is what
makes the receipt worth believing rather than merely worth verifying. And
`payer` and `beneficiary` are separate fields because an x402 `exact` settlement
is signed by an EOA, so a Circle agent wallet pays from its backing EOA while
its smart account is what trades.

**Worth going back with:** is a first-party settlement attestation on Circle's
roadmap, so sellers do not each have to be their own oracle? Right now the
buyer has to trust the seller's signature about the seller's own revenue, which
is the one weak joint in this design.

### Q8. Agent identity + compliance mid-loop
We anchor seller reputation on-chain (ERC-8004-style attestations, surfaced
in the catalog). Is first-class **agent identity** — verifiable credentials
tied to wallets — planned? And operationally: what does a compliance flag
look like *to the agent* mid-loop — what should well-written agent code do
the moment its counterparty is frozen?

### Q9. Custody-signed market making
What are the real transaction-initiation latency and rate limits for
developer-controlled wallets on Arc? Our maker quotes on a per-minute loop
from a raw EOA because we assumed custody signing was too slow — if it's
~seconds, the maker's key moves into custody too (completing Q1).

### Q10. Paymaster policy and griefing
Our Desk users' gas is sponsored via the ERC-4337 paymaster. Can sponsorship
be **scoped** — contract allowlist, per-user budget, alerts? What stops a
griefer draining a sponsorship budget with junk userOps against our
contract?

### Q11. Arc mainnet
Timeline, and what carries over — contracts, Gateway, the paymaster — so our
"what's next" slide is accurate rather than hopeful.

---

## The integration-issues list to hand the Circle team

They asked for integration specifics. Each of these cost us real debugging
time; handing over a measured list is a credibility move:

1. Circle APIs return **lowercase addresses**; web3.py rejects
   non-checksummed input, and the failure presents as throttling, not as a
   format error.
2. The w3s SDK challenge callback **never fires on an already-COMPLETED
   challenge** — resuming a PIN ceremony needs a status poll, not the
   callback.
3. The hosted PIN flow gates on literally typing **"I agree"** —
   undocumented, and it stalls headless/E2E flows.
4. Gas sponsorship appears as an **ERC-4337 paymaster event topic**, not in
   the transaction's `networkFee` — fee accounting that reads the obvious
   field mis-reports sponsored transactions.
5. `eth_getLogs`: **~15,000-block hard cap** (413), string `toBlock`
   rejected (-32602), and 429 throttling that must never be treated as a
   range error (backing off the range on a throttle collapses read reach).

---

## Post-session build map (the final week)

| Answer unlocks | We ship |
|---|---|
| Q1 — platform policies exist | Custody-held agent keys with enforced budgets; raw keys deleted from secrets |
| Q2 — any delegation path | Auto-hedger mode on the Desk (the deck's lead use case, autonomous) |
| Q3 — an Arc path exists | Register wherever they name; watch the ledger for a THIRD payer — the only real proof of discovery |
| Q4 — unified balance spans chains | "Pay from any chain" for buyer + Desk funding |
| Q5 — event push exists | Tape via events; retire the getLogs pager |

**Regardless of their answers:**
- Attempt Q4 empirically — try a Base-testnet Gateway deposit against the
  Arc seller and measure what happens.
- Prototype the Q2 fallback (a developer-controlled wallet with a user-set
  budget cap) so the hedger demo exists even if session keys are roadmap.
- Merge the archive-path fix PR; keep the day-long print-gap measurement
  running to close out the heartbeat proof.
