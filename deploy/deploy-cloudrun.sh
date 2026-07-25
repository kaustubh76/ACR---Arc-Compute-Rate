#!/usr/bin/env bash
# Deploy the ACR seller API to Google Cloud Run from LOCAL source (Cloud Build
# builds the Dockerfile — no GitHub push needed). See docs/DEPLOY.md.
#
# Default = MINIMAL, $0-friendly, NO SECRETS: live oracle reads + real x402 Circle
# settlement + webhook recording, scale-to-zero (stays in the Cloud Run free tier).
#
#   ./deploy/deploy-cloudrun.sh                       # minimal, scale-to-zero
#   ALWAYS_ON=1 ./deploy/deploy-cloudrun.sh           # min-instances=1 (~$5-15/mo)
#   POST=1 ./deploy/deploy-cloudrun.sh                # cloud also posts hourly
#
# Config via env (all have live-testnet defaults; override as needed):
#   PROJECT, REGION, SERVICE, ORACLE, REGISTRY, RPC, FACILITATOR, PAY_TO
# Secrets (only if POST=1) come from Secret Manager, NOT this script:
#   --set-secrets is appended for ACR_POSTER_PRIVATE_KEY / ACR_CIRCLE_* if named.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-acr-api}"

# --- live Arc-testnet config (public, non-secret) ---
ORACLE="${ORACLE:-0x4f00e3BDd224F4c4b4958D54cD774E84B9092609}"
REGISTRY="${REGISTRY:-0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7}"
RPC="${RPC:-https://rpc.testnet.arc.network}"
FACILITATOR="${FACILITATOR:-https://gateway-api-testnet.circle.com}"
PAY_TO="${PAY_TO:-0x33189c643774ED2713EbFf5A6923e5fa42b96eE8}"
REFRESH="${REFRESH:-3600}"

ENVS="ACR_ARC_RPC_URL=${RPC}"
ENVS="${ENVS},ACR_ORACLE_ADDRESS=${ORACLE}"
ENVS="${ENVS},ACR_REGISTRY_ADDRESS=${REGISTRY}"
ENVS="${ENVS},ACR_X402_MODE=circle"
ENVS="${ENVS},ACR_X402_FACILITATOR_URL=${FACILITATOR}"
ENVS="${ENVS},ACR_X402_PAY_TO=${PAY_TO}"
ENVS="${ENVS},ACR_TAPE_SOURCE=arc"
ENVS="${ENVS},ACR_RECEIPT_LOG_PATH=data/x402_receipts.jsonl"
ENVS="${ENVS},ACR_WEBHOOK_LOG_PATH=data/webhook_events.jsonl"
ENVS="${ENVS},ACR_REFRESH_SECONDS=${REFRESH}"
ENVS="${ENVS},ACR_CORS_ORIGINS=*"

# Scale-to-zero by default (free tier); ALWAYS_ON=1 keeps one warm instance so the
# background loop never dies. max-instances=1 always (in-memory counters assume one).
MIN_INSTANCES="0"; [ "${ALWAYS_ON:-0}" = "1" ] && MIN_INSTANCES="1"

ARGS=(
  run deploy "${SERVICE}"
  --project "${PROJECT}"
  --region "${REGION}"
  --allow-unauthenticated
  --min-instances="${MIN_INSTANCES}"
  --max-instances=1
  --cpu=1 --memory=1Gi --timeout=300
  --port=8080
  --set-env-vars "${ENVS}"
)
# IMAGE=docker.io/kaushtubh02/acr-api:latest → deploy the prebuilt image (instant,
# no Cloud Build). Otherwise build the Dockerfile from local source.
if [ -n "${IMAGE:-}" ]; then
  ARGS+=(--image "${IMAGE}")
else
  ARGS+=(--source .)
fi

# POST=1 → cloud instance signs+posts hourly prints. Provide a signer via Secret
# Manager and name it in SECRETS (e.g. SECRETS="ACR_POSTER_PRIVATE_KEY=acr-poster:latest").
if [ "${POST:-0}" = "1" ]; then
  [ -n "${SECRETS:-}" ] || { echo "POST=1 needs SECRETS=... (a Secret Manager mapping)"; exit 1; }
  ARGS+=(--set-secrets "${SECRETS}")
  echo "note: POST=1 → cloud will post hourly (REFRESH=${REFRESH}s) using SECRETS"
fi

echo "Deploying ${SERVICE} to Cloud Run (project=${PROJECT}, region=${REGION}, min-instances=${MIN_INSTANCES})..."
gcloud "${ARGS[@]}"
echo ""
gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" \
  --format="value(status.url)"
