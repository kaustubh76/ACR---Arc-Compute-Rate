# ACR — Public Cloud Deploy (Google Cloud Run + Vercel)

Make the ACR **seller API + webhooks** (Cloud Run) and the **Terminal dashboard**
(Vercel) publicly reachable, running live Circle Arc-testnet execution.

```
                 ┌────────────────────────┐        ┌──────────────────────┐
  buyers/agents →│  Cloud Run: acr-api    │←──────→│  Circle Gateway       │
  Circle webhooks│  FastAPI (Dockerfile)  │ verify │  (facilitator + DCW)  │
                 │  /x402 /webhooks /...   │ settle └──────────────────────┘
                 └───────────┬────────────┘                 ↑ reads
                             │ /terminal/data etc.           │ Arc testnet RPC
                 ┌───────────┴────────────┐        ┌─────────┴────────────┐
  browsers  →    │  Vercel: terminal      │        │  ACROracle / Registry │
                 │  Next.js (server proxy)│        │  (chain 5042002)      │
                 └────────────────────────┘        └──────────────────────┘
```

## Cost
No paid **plan** — GCP is pay-as-you-go; just **enable billing** (new accounts get
$300 free credit / 90 days). Vercel Hobby is free. Arc is testnet (no real gas).
The default deploy is **scale-to-zero** → stays in Cloud Run's free tier. Only
`ALWAYS_ON=1` (one warm instance for the hourly poster) costs ~$5–15/mo.

---

## 1. Seller API → Google Cloud Run

Deploys from **local source** (Cloud Build builds the `Dockerfile`) — no GitHub push needed.

**Prereqs** (one-time):
```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

**Deploy (MINIMAL, $0, no secrets)** — live oracle reads + real x402 Circle
settlement + webhook recording, scale-to-zero:
```bash
./deploy/deploy-cloudrun.sh
```
This binds `0.0.0.0:$PORT` (Cloud Run injects 8080), `--allow-unauthenticated`
(public), `--max-instances=1` (in-memory counters assume a single instance), and
sets the live env (`ACR_X402_MODE=circle`, `FACILITATOR_URL`, `PAY_TO`, oracle +
registry addresses, `TAPE_SOURCE=arc`, `CORS=*`). It prints the public URL:
`https://acr-api-XXXX.run.app`.

**Options:**
- `ALWAYS_ON=1 ./deploy/deploy-cloudrun.sh` — one warm instance so the background
  loop (cache warm + optional posting) never dies (~$5–15/mo).
- `POST=1 SECRETS="ACR_POSTER_PRIVATE_KEY=acr-poster:latest" ALWAYS_ON=1 ./deploy/deploy-cloudrun.sh`
  — the cloud instance also **posts hourly prints**. Store the signer in Secret
  Manager first (never in the script/env-vars):
  ```bash
  echo -n "0x<poster-key>" | gcloud secrets create acr-poster --data-file=-
  # or the Circle-custody set: acr-circle-api-key / acr-circle-entity-secret / acr-circle-wallet-id
  ```
  For Circle custody use `SECRETS="ACR_CIRCLE_API_KEY=acr-circle-api-key:latest,ACR_CIRCLE_ENTITY_SECRET=acr-circle-entity-secret:latest,ACR_CIRCLE_WALLET_ID=acr-circle-wallet-id:latest"`.
  `REFRESH=3600` is the default in the script (hourly — do NOT post every 30s).

**Persistence (optional durability):** `data/*.jsonl` (webhook feed + settlement
ledger) is ephemeral per instance. To persist across restarts, mount a GCS bucket:
```bash
gcloud run services update acr-api --region <r> \
  --add-volume name=data,type=cloud-storage,bucket=<your-bucket> \
  --add-volume-mount volume=data,mount-path=/app/data
```
(GCS-FUSE appends are rewrites — fine at demo volume.)

**Verify:**
```bash
API=https://acr-api-XXXX.run.app
curl -s $API/health | python3 -m json.tool      # gate:circle, chain 5042002, oracle_configured
curl -s $API/x402/info
curl -s $API/terminal/data | python3 -c "import sys,json;print('oracle',json.load(sys.stdin)['oracle'])"
```

---

## 2. Terminal → Vercel

The Terminal is a Next.js app with **server-side proxy routes** (not static) — it
needs a Node host. Root directory = `apps/terminal`.

```bash
cd apps/terminal
vercel deploy --prod \
  --build-env ACR_API=$API --build-env NEXT_PUBLIC_ACR_API=$API \
  --env ACR_API=$API --env NEXT_PUBLIC_ACR_API=$API
```
- `ACR_API` — server-side proxy target (all `/api/*` routes).
- `NEXT_PUBLIC_ACR_API` — the browser `/docs` link on `/developers` (build-time inlined).

Output: the public dashboard on the linked Vercel project (project name
`terminal` — deployed at `https://terminal-gules-eta.vercel.app`). While the
API is unreachable (free-tier cold start) the terminal walks its connection
ladder honestly: instant shell + skeletons, "waking the press", direct
ACROracle reads via `/api/onchain`, and the bundled `lib/fallback.json`
archived edition as the floor.

### 2b. Real Circle settlement from the cloud dashboard (optional)

The Terminal is the buyer for the UI-triggered "LIVE buyer" and console "Settle
for real" actions (`app/api/buy`, `app/api/circle/balances`, Node runtime). To
enable them in the cloud, add ONE server-only secret in Vercel:

```bash
vercel env add ACR_BUYER_PRIVATE_KEY production   # a funded EOA with an OPEN Gateway deposit
# ACR_ARC_RPC_URL is optional (the Circle SDK defaults arcTestnet); ACR_API must
# point at a seller whose /health gate == "circle".
```

- Server-only (never `NEXT_PUBLIC_`); the browser only sees settlement results.
- The buyer signs EIP-3009 and settles via Circle Gateway — real USDC on Arc.
  Prereq is operator-only: `make buyer-key` → fund → `circle gateway deposit`
  (see [`agent-runbook.md`](agent-runbook.md) §4b). A hard $0.01 cap is enforced.
- Without the key the LIVE controls stay disabled; everything else still renders.
- Seller: keep it on `ACR_X402_MODE=circle`. For heavy live demos consider a
  paid instance (the 512MB free tier can cold-start 502 the heavy `/terminal/data`).

---

## 3. Circle webhook subscription

The receiver `POST /webhooks/circle` is public + ungated and ACKs 200 on the
confirmation ping. In the **Circle console** (Programmable / Developer-Controlled
Wallets → Webhooks) add a subscription:
```
https://acr-api-XXXX.run.app/webhooks/circle
```
Signature verification: pin `ACR_CIRCLE_WEBHOOK_PUBLIC_KEY` (offline) or set
`ACR_CIRCLE_API_KEY` (fetch by key-id). Without either, events are still recorded
(`verified=null`). Confirm deliveries:
```bash
curl -s $API/webhooks/recent | python3 -m json.tool
```

---

## 4. End-to-end check (live testnet, in the cloud)

```bash
# real x402 settlement against the cloud API (needs a funded buyer EOA — see docs/agent-runbook.md)
cd apps/agent && AGENT_PRIVATE_KEY=0x<funded> npm run start -- --live --api $API --count 5 --limit 0.01 --discover
curl -s $API/revenue                       # paid_queries climbs; scheme "exact", gateway-ref
curl -s $API/marketplace/receipts
```
Open the Vercel URL → every route renders live from the cloud API; settlement refs
show as `gateway-ref`, on-chain prints as `tx`, simulations as `sim`.
