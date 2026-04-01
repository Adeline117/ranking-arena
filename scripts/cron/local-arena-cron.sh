#!/bin/bash
# Arena Data Fetch - Local Mac Mini Cron
# Triggers batch-fetch-traders groups via Vercel Cron API
# Runs every 3 hours as supplementary fetch (Vercel cron is the primary)

# Read CRON_SECRET from .env.local (never hardcode)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRON_SECRET=$(grep '^CRON_SECRET=' "$SCRIPT_DIR/../../.env.local" 2>/dev/null | cut -d'=' -f2 | tr -d '"')
if [ -z "$CRON_SECRET" ]; then
  echo "ERROR: CRON_SECRET not found in .env.local"
  exit 1
fi

API_BASE="https://www.arenafi.org/api/cron/batch-fetch-traders"
LOG_FILE="/tmp/arena-local-cron.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

fetch_group() {
  local group=$1
  log "Fetching group $group..."

  http_code=$(curl -s -w "%{http_code}" -X GET "${API_BASE}?group=${group}" \
    -H "Authorization: Bearer ${CRON_SECRET}" \
    --max-time 300 -o /tmp/arena-fetch-group.tmp 2>&1 | tail -1)

  if [ "$http_code" = "200" ]; then
    log "✅ group $group: OK"
  else
    log "❌ group $group: HTTP $http_code"
  fi

  rm -f /tmp/arena-fetch-group.tmp
  sleep 5
}

log "========================================"
log "Local cron starting (batch groups)"

# High priority (every 3h)
fetch_group "a"   # binance_futures, binance_spot, okx_futures, okx_spot
fetch_group "b"   # bybit, bybit_spot, bitget_futures
fetch_group "c"   # hyperliquid, gmx, bitunix

# Medium priority (every 6h — only run at 00/06/12/18)
HOUR=$(date +%H)
if [ $((HOUR % 6)) -eq 0 ]; then
  fetch_group "d1"  # gains, htx_futures, bitfinex, coinex
  fetch_group "d2"  # binance_web3, okx_web3, gateio, btcc
  fetch_group "e"   # drift, jupiter_perps, aevo, web3_bot, toobit, xt, etoro
  fetch_group "f"   # mexc, woox, polymarket, copin
  fetch_group "g"   # lbank, blofin
fi

log "Local cron finished"
log "========================================"
