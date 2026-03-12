#!/bin/bash
# Arena Data Fetch - Local Mac Mini Cron
# Runs every 3 hours to fetch all 26 platforms
# Faster than VPS (direct network, no Cloudflare issues)

CRON_SECRET="arena-cron-secret-2025"
API_BASE="https://www.arenafi.org/api/cron/unified-connector"
LOG_FILE="/tmp/arena-local-cron.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

fetch() {
  local platform=$1
  log "Fetching $platform..."
  response=$(curl -s -w "\n%{http_code}" -X GET "${API_BASE}?platform=${platform}" \
    -H "Authorization: Bearer ${CRON_SECRET}" \
    --max-time 300 2>&1)
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)
  if [ "$http_code" = "200" ]; then
    records=$(echo "$body" | jq -r '.result.recordsProcessed // 0' 2>/dev/null || echo 0)
    log "✅ $platform: $records records"
  else
    log "❌ $platform: HTTP $http_code"
  fi
  sleep 3
}

log "========================================"
log "Local cron starting (all 26 platforms)"

# High priority CEX (every 3h)
fetch "binance_futures"
fetch "binance_spot"
fetch "bybit"
fetch "bitget_futures"
fetch "okx_futures"

# Top DEX (every run)
fetch "hyperliquid"
fetch "jupiter_perps"
fetch "aevo"
fetch "okx_web3"
fetch "xt"

# Mid priority
fetch "gains"
fetch "htx_futures"
fetch "dydx"
fetch "bybit_spot"
fetch "drift"

# Lower priority
fetch "coinex"
fetch "binance_web3"
fetch "bitfinex"
fetch "mexc"
fetch "bingx"
fetch "gateio"
fetch "btcc"
fetch "bitunix"
fetch "web3_bot"
fetch "toobit"
fetch "etoro"

log "Local cron finished"
log "========================================"
