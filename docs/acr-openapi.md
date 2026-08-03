---
marp: true
paginate: true
---

# ACR — The Arc Compute Rate
## OpenAPI 3.1.0 · endpoint reference

Live spec: `https://acr-api-1fto.onrender.com/openapi.json`
Catalog: `https://acr-api-1fto.onrender.com/marketplace/catalog`

All paid endpoints: **$0.0001 USDC per request**, x402 `exact` scheme,
Circle Gateway (GatewayWalletBatched), network `eip155:5042002` (Arc).

---

## Paid endpoints (x402-gated)

**`GET /curve/{index_id}`** — Curve
**`GET /prints`** — Prints
**`GET /prints/{index_id}`** — Print One
**`GET /seller-scores/{index_id}`** — Seller Scores
**`GET /vol/{index_id}`** — Vol

---

## Free endpoints (no payment required)

`GET /` — Root
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
`GET /futures` — Futures Roster
`GET /futures/{index_id}` — Futures Desk
`GET /health` — Health
`GET /hedger` — Hedger State
`GET /marketplace/catalog` — Marketplace Catalog
`GET /marketplace/receipts` — Marketplace Receipts
`GET /onchain/{index_id}` — Onchain Print
`GET /revenue` — Revenue
`GET /terminal/data` — Terminal Data
`POST /webhooks/circle` — Circle Webhook
`GET /webhooks/recent` — Webhooks Recent
`GET /x402/info` — X402 Info
