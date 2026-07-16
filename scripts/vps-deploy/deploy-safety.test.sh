#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$SCRIPT_DIR/deploy.sh"

if grep -Eq 'pm2 (delete|stop|restart|reload) all' "$DEPLOY"; then
  echo "deploy.sh must never mutate every PM2 app" >&2
  exit 1
fi

grep -Fq 'pm2 startOrReload "$ECOSYSTEM" --only "$app" --update-env' "$DEPLOY"
grep -Fq 'INGEST_PID_BEFORE=' "$DEPLOY"
grep -Fq 'INGEST_PID_AFTER=' "$DEPLOY"
grep -Fq 'arena-ingest-worker-sg PID' "$DEPLOY"

echo "VPS deploy scope safety passed"
