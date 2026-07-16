#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$SCRIPT_DIR/deploy.sh"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SG_CONFIG="$ROOT_DIR/infra/vps-playwright/ecosystem.config.js"
JP_CONFIG="$ROOT_DIR/infra/vps-playwright/ecosystem-jp.config.js"

if grep -Eq 'pm2 (delete|stop|restart|reload) all' "$DEPLOY"; then
  echo "deploy.sh must never mutate every PM2 app" >&2
  exit 1
fi

grep -Fq 'pm2 startOrReload "$ECOSYSTEM" --only "$app" --update-env' "$DEPLOY"
grep -Fq 'INGEST_PID_BEFORE=' "$DEPLOY"
grep -Fq 'INGEST_PID_AFTER=' "$DEPLOY"
grep -Fq 'arena-ingest-worker-sg PID' "$DEPLOY"
grep -Fq 'source /etc/arena-proxy.env' "$DEPLOY"
grep -Fq 'set -a' "$DEPLOY"
grep -Fq 'APPS=(arena-scraper arena-proxy)' "$DEPLOY"
grep -Fq 'APPS=(arena-proxy)' "$DEPLOY"
grep -Fq 'required deploy file missing' "$DEPLOY"
grep -Fq 'arena-proxy.service must remain inactive and disabled' "$DEPLOY"
grep -Fq 'throw new Error("retired arena-cron is present in PM2")' "$DEPLOY"

if grep -Fq 'scraper-cron.mjs' "$DEPLOY"; then
  echo "deploy.sh must never deploy the retired arena-cron" >&2
  exit 1
fi
if grep -Eq 'APPS=.*arena-cron' "$DEPLOY"; then
  echo "deploy.sh must never start the retired arena-cron" >&2
  exit 1
fi

PROXY_KEY=topology-test node - "$SG_CONFIG" "$JP_CONFIG" <<'NODE'
const [sgPath, jpPath] = process.argv.slice(2)
const names = (configPath) => require(configPath).apps.map((app) => app.name)
const sg = names(sgPath)
const jp = names(jpPath)
if (JSON.stringify(sg) !== JSON.stringify(['arena-scraper', 'arena-proxy'])) {
  throw new Error(`unexpected SG PM2 topology: ${sg.join(',')}`)
}
if (JSON.stringify(jp) !== JSON.stringify(['arena-proxy'])) {
  throw new Error(`unexpected JP PM2 topology: ${jp.join(',')}`)
}
NODE

echo "VPS deploy scope safety passed"
