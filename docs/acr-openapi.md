---
marp: true
paginate: true
---

# ACR — The Arc Compute Rate
## OpenAPI 3.1.0 · endpoint reference

Live spec: `https://acr-api-1fto.onrender.com/openapi.json`
Catalog: `https://acr-api-1fto.onrender.com/marketplace/catalog`

Index endpoints: **$0.0001 USDC per request**, x402 `exact` scheme,
Circle Gateway (GatewayWalletBatched), network `eip155:5042002` (Arc).
Fleet sellers (`/compute/{label}`) price per unit; the catalog carries each one's terms.

Agent-to-agent calls may present an `AGENT-CARD` (see `GET /agent/challenge`);
carded tape reads pass Google Cloud Model Armor in both directions (`GET /armor/info`).

---

## Paid endpoints (x402-gated) · 6

**`GET /compute/{label}`** — Compute
**`GET /curve/{index_id}`** — Curve
**`GET /prints`** — Prints
**`GET /prints/{index_id}`** — Print One
**`GET /seller-scores/{index_id}`** — Seller Scores
**`GET /vol/{index_id}`** — Vol

---

## Free endpoints (no payment required) · 34

`GET /` — Root
`GET /agent/challenge` — Agent Challenge
`GET /agent/info` — Agent Info
`GET /agent/whoami` — Agent Whoami
`GET /armor/info` — Armor Info
`POST /demo/attack/start` — Demo Attack Start
`GET /demo/attack/status` — Demo Attack Status
`POST /demo/buyer/start` — Demo Buyer Start
`GET /demo/buyer/status` — Demo Buyer Status
`POST /desk/challenge` — Desk Challenge
`POST /desk/faucet` — Desk Faucet
`POST /desk/limits` — Desk Limits
`POST /desk/session` — Desk Session
`POST /desk/wallet` — Desk Wallet
`POST /desk/withdrawable` — Desk Withdrawable
`GET /fleet` — Fleet Listings
`GET /futures` — Futures Roster
`GET /futures/{index_id}` — Futures Desk
`GET /graph/operations` — Graph Operations
`POST /graph/query` — Graph Proxy Query
`GET /health` — Health
`GET /hedger` — Hedger State
`GET /humanid/info` — Humanid Info
`GET /marketplace/catalog` — Marketplace Catalog
`GET /marketplace/receipts` — Marketplace Receipts
`GET /onchain/{index_id}` — Onchain Print
`GET /rating/{seller}` — Rating
`GET /revenue` — Revenue
`GET /tca/human` — Tca Human
`GET /tca/{payer}` — Tca
`GET /terminal/data` — Terminal Data
`POST /webhooks/circle` — Circle Webhook
`GET /webhooks/recent` — Webhooks Recent
`GET /x402/info` — X402 Info

---

*Rendered by `scripts/gen_openapi_doc.py` from `app.openapi()` — 40 routes;*
*2 operator routes omitted on purpose. `make openapi-doc-check` fails when this is stale.*
