#!/usr/bin/env bash
# Run the Arena ingest worker CONTAINER on the SG VPS using plain `docker run`.
#
# Why not docker-compose.sg.yml? The SG box has docker (v29) but NOT the
# `docker compose` v2 plugin — this wrapper is the compose file's equivalent in
# plain `docker run`, so cutover needs zero extra box install.
# See docs/INGEST_WORKER_DEPLOY.md (container path).
#
# Two image sources:
#   * GHCR (default)   — `docker login ghcr.io` with a read:packages PAT, then
#                        `bash worker/docker-run-sg.sh deploy [tag]`.
#   * Local build      — build on the box (docs: "build on SG" path) tagged
#                        `arena-ingest:local`, then `... deploy-local`. No PAT,
#                        no registry — the credential-free path.
#
# FOUR things this script gets right (each cost a failed verify run to find):
#   1. Env quotes — the box .env has KEY="value"; docker `--env-file` does NOT
#      strip quotes, so pg sees a quoted connection string and misparses the host.
#      We pre-strip surrounding double-quotes into a clean env-file.
#   2. Env & non-root — the container runs as pwuser (uid 1000, Chromium without
#      --no-sandbox). It can't read a root:0600 .env via a mount, so we feed the
#      clean env-file via --env-file (docker reads it as root at create time).
#   3. Profile volume perms — pwuser must OWN the mounted profile dir or Chromium
#      can't mkdir profiles (EACCES). We chown it to 1000:1000 (root still writes
#      it on a pm2 rollback, so this is safe both ways).
#   4. Side-by-side safety — distinct container name; `stop-pm2` is the explicit
#      cutover step, run only AFTER the container reports ready + ingesting.
set -euo pipefail

IMAGE="${INGEST_IMAGE:-ghcr.io/adeline117/ranking-arena/ingest-worker}"
NAME="arena-ingest-worker-sg-ctr"
SRC_ENV="/opt/arena-ingest/worker/.env"          # the box's real env (pm2 uses it)
CLEAN_ENV="/tmp/arena-ingest-clean.env"          # quote-stripped, docker --env-file
PROFILE_VOL="/opt/arena-ingest/.arena-ingest"    # shared warm-cookie profiles
PW_UID=1000                                      # pwuser in the Playwright image

prep_env() {
  # strip surrounding double-quotes from KEY="value" lines (fix #1)
  sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/\1=\2/' "${SRC_ENV}" > "${CLEAN_ENV}"
  chmod 600 "${CLEAN_ENV}"
}

run_container() {
  local tag="$1"
  if [ "${NO_PULL:-0}" != "1" ]; then
    echo "[docker-run-sg] pulling ${IMAGE}:${tag} …"; docker pull "${IMAGE}:${tag}"
  else
    echo "[docker-run-sg] NO_PULL=1 — using local image ${IMAGE}:${tag}"
  fi
  prep_env                                       # fix #1 + #2
  mkdir -p "${PROFILE_VOL}/profiles"
  chown -R "${PW_UID}:${PW_UID}" "${PROFILE_VOL}"  # fix #3
  echo "[docker-run-sg] (re)starting container ${NAME} …"
  docker rm -f "${NAME}" 2>/dev/null || true
  docker run -d \
    --name "${NAME}" \
    --env-file "${CLEAN_ENV}" \
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
  echo "[docker-run-sg] waiting for Redis connect + first ingestion (60s) …"
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null)" != "true" ]; then
      echo "[docker-run-sg] ✗ container exited — last logs:" >&2
      docker logs --tail 30 "${NAME}" 2>&1 >&2 || true; return 1
    fi
    # healthy signal: Redis connected AND at least one job processed for vps_sg
    if docker logs "${NAME}" 2>&1 | grep -q "Redis connected" \
       && docker logs "${NAME}" 2>&1 | grep -qE "\[vps_sg\]|traders,"; then
      echo "[docker-run-sg] ✓ Redis connected + ingesting"
      docker ps --filter "name=${NAME}" --format '  {{.Names}} {{.Status}}'
      return 0
    fi
    sleep 1
  done
  echo "[docker-run-sg] ⚠ no clear ingestion signal in 60s — last logs:" >&2
  docker logs --tail 30 "${NAME}" 2>&1 >&2 || true; return 1
}

case "${1:-}" in
  deploy)        run_container "${2:-latest}"; verify_ready ;;
  deploy-local)  INGEST_IMAGE=arena-ingest IMAGE=arena-ingest NO_PULL=1 run_container "${2:-local}"; verify_ready ;;
  rollback)
    [ -n "${2:-}" ] || { echo "rollback needs a <tag>" >&2; exit 2; }
    run_container "$2"; verify_ready ;;
  stop-pm2)
    echo "[docker-run-sg] disabling the OLD pm2 worker (cutover) …"
    pm2 stop arena-ingest-worker-sg && pm2 save
    echo "[docker-run-sg] pm2 worker stopped; container ${NAME} is now the sole vps_sg ingester." ;;
  start-pm2)   # rollback helper: bring the pm2 worker back
    echo "[docker-run-sg] restarting the pm2 worker (rollback) …"
    docker rm -f "${NAME}" 2>/dev/null || true
    pm2 start arena-ingest-worker-sg 2>/dev/null || pm2 restart arena-ingest-worker-sg
    pm2 save ;;
  *)
    echo "usage: $0 {deploy [tag] | deploy-local [tag] | rollback <tag> | stop-pm2 | start-pm2}" >&2
    exit 2 ;;
esac
