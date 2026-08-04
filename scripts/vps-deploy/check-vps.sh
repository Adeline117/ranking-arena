#!/usr/bin/env bash
# Read-only status check for the VPS-owned proxy and canonical SG ingest worker.
# This script never reads or prints runtime credentials.

set -u

readonly SG_HOST="root@45.76.152.169"
readonly JP_HOST="root@149.28.27.242"
readonly -a SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=5)

check_vps() {
  local host="$1"
  local label="$2"
  local role="$3"

  echo "=== $label ($host) ==="

  if ! ssh "${SSH_OPTIONS[@]}" "$host" bash -s -- "$role" <<'REMOTE_STATUS'
set -u

role="$1"
status=0

check_pm2_app() {
  app="$1"
  pid="$(pm2 pid "$app" 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
  case "$pid" in
    ''|0|*[!0-9]*)
      echo "  $app: NOT ONLINE"
      return 1
      ;;
    *)
      echo "  $app: online (pid $pid)"
      ;;
  esac
}

if ! command -v pm2 >/dev/null 2>&1; then
  echo "  PM2: NOT INSTALLED"
  exit 1
fi

check_pm2_app arena-proxy || status=1
if curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3456/health >/dev/null; then
  echo "  arena-proxy health: healthy"
else
  echo "  arena-proxy health: UNHEALTHY"
  status=1
fi

if [ "$role" = "sg" ]; then
  check_pm2_app arena-ingest-worker-sg || status=1
fi

exit "$status"
REMOTE_STATUS
  then
    echo "  RESULT: FAILED"
    echo
    return 1
  fi

  echo "  RESULT: OK"
  echo
}

target="${1:-all}"
status=0

case "$target" in
  sg)
    check_vps "$SG_HOST" "SG VPS" sg || status=1
    ;;
  jp)
    check_vps "$JP_HOST" "JP VPS" jp || status=1
    ;;
  all)
    check_vps "$SG_HOST" "SG VPS" sg || status=1
    check_vps "$JP_HOST" "JP VPS" jp || status=1
    ;;
  *)
    echo "Usage: $0 [sg|jp|all]" >&2
    exit 2
    ;;
esac

exit "$status"
