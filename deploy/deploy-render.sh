#!/usr/bin/env bash
# Deploy the ACR seller API to Render from a prebuilt Docker image (Docker Hub),
# non-interactively. Used when Cloud Run isn't available (e.g. gcloud not authed).
# Same MINIMAL, no-secrets mode: live oracle reads + real x402 Circle settlement
# + webhook recording. Render free web services spin down when idle (cold start
# on next request); set PLAN=starter for always-on.
#
#   # 1) build + push the image (once):
#   docker build -t kaushtubh02/acr-api:latest . && docker push kaushtubh02/acr-api:latest
#   # 2) deploy:
#   ./deploy/deploy-render.sh
set -euo pipefail

IMAGE="${IMAGE:-docker.io/kaushtubh02/acr-api:latest}"
NAME="${NAME:-acr-api}"
REGION="${REGION:-oregon}"
PLAN="${PLAN:-free}"

ORACLE="${ORACLE:-0x4f00e3BDd224F4c4b4958D54cD774E84B9092609}"
REGISTRY="${REGISTRY:-0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7}"
RPC="${RPC:-https://rpc.testnet.arc.network}"
FACILITATOR="${FACILITATOR:-https://gateway-api-testnet.circle.com}"
PAY_TO="${PAY_TO:-0x33189c643774ED2713EbFf5A6923e5fa42b96eE8}"
# sim tape is the safe cloud default (arc's blocking RPC scan starves the 1-CPU
# free tier's event loop). Keep the sim SMALL so the store build fits 512MB, and
# refresh hourly (not every 30s) to keep the box quiet.
TAPE="${TAPE:-sim}"
SIM_EVENTS="${SIM_EVENTS:-3000}"
# The attack sim is the app's heaviest transient allocation; without this the
# exhibit + live Attack Lab runs default to 2500 (~330MB transient) and can
# OOM-spike the free tier. Floor is ~800 — below that the hour-0 cleaning
# stack leaves zero observations and the run errors (verified); 1250 halves
# the default's footprint with margin above the floor.
ATTACK_SIM_EVENTS="${ATTACK_SIM_EVENTS:-1250}"
REFRESH="${REFRESH:-3600}"

render services create \
  --name "${NAME}" \
  --type web_service \
  --runtime image \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --plan "${PLAN}" \
  --num-instances 1 \
  --health-check-path /health \
  --env-var ACR_ARC_RPC_URL="${RPC}" \
  --env-var ACR_ORACLE_ADDRESS="${ORACLE}" \
  --env-var ACR_REGISTRY_ADDRESS="${REGISTRY}" \
  --env-var ACR_X402_MODE=circle \
  --env-var ACR_X402_FACILITATOR_URL="${FACILITATOR}" \
  --env-var ACR_X402_PAY_TO="${PAY_TO}" \
  --env-var ACR_TAPE_SOURCE="${TAPE}" \
  --env-var ACR_SIM_EVENTS_PER_SERVICE="${SIM_EVENTS}" \
  --env-var ACR_ATTACK_SIM_EVENTS_PER_SERVICE="${ATTACK_SIM_EVENTS}" \
  --env-var ACR_REFRESH_SECONDS="${REFRESH}" \
  --env-var ACR_RECEIPT_LOG_PATH=data/x402_receipts.jsonl \
  --env-var ACR_WEBHOOK_LOG_PATH=data/webhook_events.jsonl \
  --env-var ACR_CORS_ORIGINS='*' \
  --confirm --output json
