# ACR Machine TCA, over MCP

Six read-only tools that let an MCP host (Claude Desktop, Claude Code, anything
speaking stdio MCP) ask the ACR seller what compute actually cost a wallet, which
seller to route to, and what the tape says — without a wallet in the loop. Nothing
here spends money or signs a transaction.

```json
{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["tsx", "/path/to/ACR/mcp/src/server.ts"],
      "env": {
        "ACR_API": "https://acr-api-1fto.onrender.com",
        "ACR_AGENT_PRIVATE_KEY": "0x<a 32-byte key of your own>"
      }
    }
  }
}
```

| tool | what it answers |
|---|---|
| `my_tca` | a wallet's transaction-cost analysis: what it paid vs the benchmark, slippage, overpaid. `"me"` answers the human-proof challenge and returns ONE card across every wallet the person owns (`ACR_HUMAN_AGENT_KEY`) |
| `reroute_suggestion` | the seller this payer should have bought from, and the saving |
| `seller_rating` | one seller's rating, components and human depth |
| `benchmark_price` | the index print a purchase is measured against |
| `get_rate` | the on-chain print for an index |
| `query_tape` | any named subgraph operation through the seller's read proxy |

## It is a carded caller

Every tool's `fetch` is wrapped by `src/card.ts`, the same EIP-712 encoder the buyer
agent uses. With `ACR_AGENT_PRIVATE_KEY` set, every call carries an `AGENT-CARD`
header, and the seller answers from the **carded** tier: a rate-limit budget keyed on
*your* key rather than the host ceiling every anonymous reader behind a proxy shares,
and — on `query_tape` — Google Cloud Model Armor screening the request and the reply.
Unset, the server is anonymous, which is a working state, not an error.

| env | meaning |
|---|---|
| `ACR_API` | the seller to call (default `https://acr-api-1fto.onrender.com`) |
| `ACR_AGENT_PRIVATE_KEY` | signs the card. Any 32-byte key; nothing is enrolled, nothing is spent |
| `ACR_AGENT_HUMAN_CLUSTER` | **opt-in** human claim: the cluster `HumanIdMirror.clusterOf` records for this key's wallet in the *current* 7-day window. A claim the chain cannot confirm is a **401**, never a silent downgrade, so leave it unset unless you have resolved that wallet |
| `ACR_ARC_CHAIN_ID` | the card's domain chain (default `5042002`, Arc testnet) |
| `ACR_HUMAN_AGENT_KEY` | lets `my_tca("me")` answer the **AgentKit** gate (production): the key of a wallet registered in AgentBook. The plugin signs each challenge (CAIP-122, EIP-191) in-process; the key never leaves it. A demo buyer's key derives from its public label |
| `ACR_HUMAN_NULLIFIER` | the same, for a local **dev** gate (`ACR_HUMANID_MODE=dev`): a bare nullifier. Not a spending key; anyone holding it can read that human's costs |

The card names no `verifyingContract` on purpose — the seller, not a contract,
verifies it — so `audience` (`acr-index-api`, read from `GET /agent/challenge`) and
a 15-minute lifetime stand in for one. `GET /agent/whoami` with the header tells you
which tier you landed on and why.

Proved against production 2026-09-13: a stdio client calling `query_tape` and
`seller_rating` with a throwaway key moved the seller's `cards_verified` counter
14 → 17 (`GET /agent/info`).

```bash
npm ci && npm test      # 16 tests; the card test pins the header on every tool's upstream call
```

Full design: [`docs/AGENT-MODULE.md`](../docs/AGENT-MODULE.md).
