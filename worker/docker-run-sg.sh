#!/usr/bin/env bash
# Run the Arena ingest worker CONTAINER on the SG VPS using plain `docker run`.
#
# Why not docker-compose.sg.yml? The SG box has docker (v29) but NOT the
# `docker compose` v2 plugin — this wrapper is the compose file's exact
# equivalent in plain `docker run`, so cutover needs zero extra box install.
# See docs/INGEST_WORKER_DEPLOY.md (container path).
#
# Prereqs on the box (one-time, operator): `docker login ghcr.io` with a
# read:packages PAT. The image is published by .github/workflows/build-ingest-image.yml.
#
# Usage (on the SG box, or `ssh root@SG bash -s -- <args>`):
#   bash worker/docker-run-sg.sh deploy [<tag>]   # pull <tag|latest> + (re)start container, verify ready
#   bash worker/docker-run-sg.sh rollback <tag>   # re-pin to a previous :<sha> tag
#   bash worker/docker-run-sg.sh stop-pm2         # disable the OLD pm2 worker (the actual cutover step)
#
# Safe by design: `deploy` only manages the CONTAINER; it does NOT touch the
# running pm2 worker. Run them side-by-side first, confirm the container is
# `ready`, THEN `stop-pm2`. Rollback = `rollback <prev-sha>` (container) +
# `pm2 restart arena-ingest-worker-sg` (fall back to pm2) if needed.
set -euo pipefail

IMAGE="ghcr.io/adeline117/ranking-arena/ingest-worker"
NAME="arena-ingest-worker-sg-ctr"        # distinct from the pm2 app name (run side-by-side)
ENV_FILE="/opt/arena-ingest/worker/.env"
PROFILE_VOL="/opt/arena-ingest/.arena-ingest"

run_container() {
  local tag="$1"
  echo "[docker-run-sg] pulling ${IMAGE}:${tag} …"
  docker pull "${IMAGE}:${tag}"
  echo "[docker-run-sg] (re)starting container ${NAME} …"
  docker rm -f "${NAME}" 2>/dev/null || true
  mkdir -p "${PROFILE_VOL}"
  docker run -d \
    --name "${NAME}" \
    --env-file "${ENV_FILE}" \
    -e INGEST_REGIONS=vps_sg \
    -e INGEST_LOCAL_REGION=vps_sg \
    -v "${PROFILE_VOL}:/app/.arena-ingest" \
    --restart unless-stopped \
    --init \
    --memory 3g \
    --shm-size 1gb \
    --stop-timeout 35 \
    --log-opt max-size=10m \
    --log-opt max-file=5 \
    "${IMAGE}:${tag}"
}

verify_ready() {
  echo "[docker-run-sg] waiting for 'ready' (45s) …"
  for _ in $(seq 1 45); do
    if docker logs "${NAME}" 2>&1 | grep -q "\[ingest-worker\] ready"; then
      echo "[docker-run-sg] ✓ container reports ready"
      docker ps --filter "name=${NAME}" --format '  {{.Names}} {{.Status}}'
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null)" != "true" ]; then
      echo "[docker-run-sg] ✗ container exited — last logs:" >&2
      docker logs --tail 30 "${NAME}" 2>&1 >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "[docker-run-sg] ✗ no 'ready' within 45s — last logs:" >&2
  docker logs --tail 30 "${NAME}" 2>&1 >&2 || true
  return 1
}

case "${1:-}" in
  deploy)
    run_container "${2:-latest}"
    verify_ready
    ;;
  rollback)
    [ -n "${2:-}" ] || { echo "rollback needs a <tag> (e.g. a previous :<sha>)" >&2; exit 2; }
    run_container "$2"
    verify_ready
    ;;
  stop-pm2)
    echo "[docker-run-sg] disabling the OLD pm2 worker (cutover) …"
    pm2 stop arena-ingest-worker-sg && pm2 save
    echo "[docker-run-sg] pm2 worker stopped; container ${NAME} is now the sole vps_sg ingester."
    ;;
  *)
    echo "usage: $0 {deploy [tag] | rollback <tag> | stop-pm2}" >&2
    exit 2
    ;;
esac
