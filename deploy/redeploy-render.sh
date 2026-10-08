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
# The operator's decisions live on the same disk that is about to be erased, and
# nothing was pulling them in. A redeploy without this silently reverts the
# traction page to the rows that ship inside the image — a smaller number, not a
# broken page, which is the failure shape nobody investigates.
# --api "${URL}" is NOT optional. Both archivers default to ACR_API_URL or the
# MAINNET press, and this script redeploys whichever service SERVICE_ID names —
# so unqualified they interrogated a different host than the one about to be
# erased. Measured: the default answered about acr-api-mainnet (which has no
# operator at all, so "nothing to archive", so the gate passed) while the
# testnet press held 19 decisions nobody had asked about. A preflight pointed at
# the wrong host is worse than none: it reports safety it never checked.
DECISIONS_RC=0
uv run python "${ROOT}/scripts/archive_decisions.py" --api "${URL}" --check || DECISIONS_RC=$?
if [[ "${DECISIONS_RC}" -eq 1 ]]; then
  echo ""
  echo "  Production holds operator decisions this repo does not."
  echo "  Run: make archive-decisions   then commit the archive."
  exit 1
elif [[ "${DECISIONS_RC}" -ne 0 ]]; then
  # 2 is "I could not tell" — a sleeping host, a truncated page. Distinguished
  # from 1 because the two call for opposite actions, and because printing the
  # "production is ahead" sentence for an unread host sends the operator to run
  # an archiver that will fail the same way.
  echo ""
  echo "  Could not read ${URL}, so it cannot be shown to be safe to erase."
  echo "  Wake it: curl ${URL}/health   (a free-tier cold start takes ~20 s), then re-run."
  exit 1
fi

if ! uv run python "${ROOT}/scripts/archive_receipts.py" --api "${URL}" --check; then
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
    # THE WHOLE ROUTE SET, not one route. This grepped `/desk/withdrawable`
    # and called it "this is the image we built" — but every image since
    # September has that route, so the check passed on images built weeks
    # apart and could not distinguish them at all. Measured 2026-10-08: the
    # mainnet service was serving a 44-route image with no /operator/* and no
    # /par while this line reported success, because the one route it asks
    # about was present in both.
    #
    # `verify_deploy_drift.py` already answers the real question — does this
    # host serve exactly what this checkout builds, in both directions — and
    # it is the tool that FOUND the 6-route gap. Reused rather than
    # reimplemented: a second opinion about route sets would eventually
    # disagree with the one `make verify-drift` reports.
    echo "  ▸ comparing the served route set against this checkout"
    # STRICT, because at the end of a deploy "I could not read the host" is
    # the one answer that must not pass. The default is deliberately lenient
    # so a cold start does not read as a missing feature; a gate needs the
    # opposite.
    if VERIFY_DRIFT_HOSTS="${URL}" VERIFY_DRIFT_STRICT=1 \
         uv run python "${ROOT}/scripts/verify_deploy_drift.py"; then
      echo "  ✓ the deployment serves exactly what this checkout builds"
      exit 0
    fi
    echo "  ✗ the service does not serve what this checkout builds." >&2
    echo "    If it is a PINNED image (acr-api-mainnet is), a deploy re-pulls the" >&2
    echo "    pin and changes nothing — the service's image URL has to be set:" >&2
    echo "      render services update ${SERVICE_ID} --image ${IMAGE}:${TAG} --confirm" >&2
    exit 1
  fi
  sleep 10
done
echo "✗ ${URL}/health never came back" >&2
exit 1
