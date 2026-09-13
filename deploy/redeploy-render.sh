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

# The archive must hold every settlement production has, or this image erases
# them: the free tier has no disk and the seller rehydrates from the file that
# ships inside the image. `--check` exits 1 when production is ahead of the repo.
if ! uv run python "${ROOT}/scripts/archive_receipts.py" --check; then
  echo "production holds settlements the archive lacks — run 'uv run python scripts/archive_receipts.py', commit, then redeploy" >&2
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
DEPLOY_ID="$(curl -sS -X POST "https://api.render.com/v1/services/${SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"clearCache":"do_not_clear"}' \
  | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\(dep-[^"]*\)".*/\1/p' | head -1)"
if [[ -z "${DEPLOY_ID}" ]]; then
  echo "✗ Render did not return a deploy id — nothing was triggered" >&2
  exit 1
fi
echo "  deploy ${DEPLOY_ID}"

# Follow THIS deploy to a terminal state. A /health that answers proves only
# that something is running — very possibly the previous image, because a
# failed build leaves the old one serving happily. The deploy's own status is
# the only witness that the code in this working tree is what is live.
echo "▸ waiting for the deploy to go live (free-tier builds are slow)"
STATUS=""
for _ in $(seq 1 90); do
  sleep 10
  STATUS="$(curl -sS -m 20 "https://api.render.com/v1/services/${SERVICE_ID}/deploys/${DEPLOY_ID}" \
    -H "Authorization: Bearer ${RENDER_API_KEY}" \
    | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  case "${STATUS}" in
    live) echo "  ✓ deploy ${DEPLOY_ID} is live"; break ;;
    build_failed|update_failed|canceled|pre_deploy_failed)
      echo "  ✗ deploy ${DEPLOY_ID} ended as '${STATUS}' — production is STILL the old image" >&2
      exit 1 ;;
    *) printf '  · %s\n' "${STATUS:-unknown}" ;;
  esac
done
if [[ "${STATUS}" != "live" ]]; then
  echo "✗ deploy ${DEPLOY_ID} never reached 'live' (last status: ${STATUS:-unknown})" >&2
  exit 1
fi

echo "▸ verifying the service answers"
for i in $(seq 1 30); do
  if curl -sf -m 20 "${URL}/health" >/dev/null 2>&1; then
    echo "  ✓ /health responding after ~$((i * 10))s"
    curl -s -m 20 "${URL}/health"
    echo
    if curl -s -m 20 "${URL}/openapi.json" | grep -q '/desk/withdrawable'; then
      echo "  ✓ the desk's routes are present"
    else
      echo "  ✗ /desk/withdrawable MISSING — this is not the image we built" >&2
      exit 1
    fi
    exit 0
  fi
  sleep 10
done
echo "✗ ${URL}/health never came back" >&2
exit 1
