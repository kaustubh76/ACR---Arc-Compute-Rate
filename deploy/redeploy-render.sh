#!/usr/bin/env bash
# Ship the current code to the live seller.
#
# Render is NOT wired to this repo — the `acr-api` service pulls a prebuilt
# image from Docker Hub. `deploy-render.sh` beside this only CREATES the
# service, so until this script existed there was no path from a commit to
# production at all: it was a manual `docker build` someone had to remember.
#
#   ./deploy/redeploy-render.sh                 # build, push, redeploy, verify
#   SKIP_BUILD=1 ./deploy/redeploy-render.sh    # just redeploy the current tag
#
# Needs: docker login (Docker Hub) and RENDER_API_KEY.
set -euo pipefail

IMAGE="${IMAGE:-docker.io/kaushtubh02/acr-api}"
SERVICE_ID="${SERVICE_ID:-srv-d9ifidfaqgkc73a19eug}"   # acr-api
URL="${URL:-https://acr-api-1fto.onrender.com}"
TAG="$(date -u +%Y-%m-%d-%H%M)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  echo "RENDER_API_KEY not set (it is in .env)" >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  # --platform linux/amd64 is MANDATORY from an Apple-silicon Mac. An arm64
  # push produces an image Render accepts and then silently cannot start, and
  # there is no second route to this host.
  echo "▸ building ${IMAGE}:${TAG} (linux/amd64)"
  docker build --platform linux/amd64 -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" "${ROOT}"

  # Push the dated tag as well as :latest so a bad deploy has a rollback target
  # — the service tracks :latest, which is mutable and otherwise unrecoverable.
  echo "▸ pushing ${TAG} and latest"
  docker push "${IMAGE}:${TAG}"
  docker push "${IMAGE}:latest"
fi

echo "▸ triggering a Render deploy"
curl -sS -X POST "https://api.render.com/v1/services/${SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"clearCache":"do_not_clear"}' | head -c 400
echo

echo "▸ waiting for the service to come back (free tier cold starts are slow)"
for i in $(seq 1 60); do
  sleep 10
  if curl -sf -m 20 "${URL}/health" >/dev/null 2>&1; then
    echo "  ✓ /health responding after ~$((i * 10))s"
    curl -s -m 20 "${URL}/health"
    echo
    # The desk's own smoke test: this path only exists in a post-fix image, so
    # its absence means the redeploy did not actually take.
    if curl -s -m 20 "${URL}/openapi.json" | grep -q '/desk/withdrawable'; then
      echo "  ✓ /desk/withdrawable present — the new image is live"
    else
      echo "  ✗ /desk/withdrawable MISSING — Render is still serving the old image" >&2
      exit 1
    fi
    exit 0
  fi
done
echo "✗ ${URL}/health never came back" >&2
exit 1
