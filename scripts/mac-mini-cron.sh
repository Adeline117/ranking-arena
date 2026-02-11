#!/bin/bash
# Mac Mini M4 — 主力抓取服务器
# 负责18个平台，VPS只保留需要真实亚洲机房IP的8个大所
#
# Mac Mini: MEXC, CoinEx, XT, LBank, KuCoin, BingX, Phemex, Weex,
#           BloFin, Gate.io, DYDX, Gains, BTCC, OKX, Hyperliquid,
#           GMX, Aevo, Jupiter Perps
#
# VPS only: Binance (futures/spot/web3), Bybit (futures/spot),
#           Bitget (futures/spot), HTX

set -euo pipefail

SCRIPT_DIR="/Users/adelinewen/ranking-arena/scripts/import"
LOG_DIR="/Users/adelinewen/ranking-arena/logs"
LOCK_DIR="/tmp/arena_mac_cron.lock"

mkdir -p "$LOG_DIR"
cd /Users/adelinewen/ranking-arena

# 防止并发 (mkdir is atomic on macOS)
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -d "$LOCK_DIR" ] && find "$LOCK_DIR" -maxdepth 0 -mmin +45 | grep -q .; then
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR"
    else
        echo "$(date): Another cron is running, skip" >> "$LOG_DIR/mac-cron.log"
        exit 0
    fi
fi
trap "rm -rf '$LOCK_DIR'" EXIT

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_DIR/mac-cron.log"
}

run_script() {
    local script="$1"
    local args="${2:-}"
    local timeout_sec="${3:-300}"

    if [ ! -f "$SCRIPT_DIR/$script" ]; then
        log "SKIP $script (not found)"
        return 0
    fi

    log "START $script $args"
    if gtimeout "$timeout_sec" node "$SCRIPT_DIR/$script" $args >> "$LOG_DIR/$script.log" 2>&1; then
        log "OK    $script"
    else
        local exit_code=$?
        log "FAIL  $script (exit $exit_code)"
    fi
}

cleanup_chrome() {
    pkill -f "Chromium.*--headless" 2>/dev/null || true
    pkill -f "chrome.*--headless" 2>/dev/null || true
}

log "=== Mac Mini cron start ==="
cleanup_chrome

# ========== Tier 1: 大平台 (API/Chrome, 每轮必跑) ==========
run_script "import_okx_futures.mjs" "ALL" 600
run_script "import_okx_web3.mjs" "ALL" 600
run_script "import_binance_web3_v2.mjs" "ALL" 600
run_script "import_mexc.mjs" "ALL" 600
run_script "import_kucoin.mjs" "ALL" 600

# ========== Tier 2: 中等平台 (Chrome) ==========
run_script "import_coinex.mjs" "ALL" 300
run_script "import_xt.mjs" "ALL" 300
run_script "import_lbank.mjs" "ALL" 300
run_script "import_blofin.mjs" "ALL" 300
run_script "import_gateio.mjs" "ALL" 300
run_script "import_phemex.mjs" "ALL" 300

# ========== Tier 3: CF-blocked (需要代理+Chrome) ==========
run_script "import_bingx_mac.mjs" "ALL" 300
run_script "import_weex.mjs" "ALL" 300

# ========== Tier 4: 纯API / DEX ==========
run_script "import_dydx_enhanced.mjs" "ALL" 600
run_script "import_gains.mjs" "ALL" 300
run_script "import_btcc.mjs" "ALL" 300
run_script "import_bitfinex_v2.mjs" "ALL" 120
run_script "import_toobit.mjs" "ALL" 120

# DEX platforms (pure API, no Chrome needed)
# Enrich scripts need to run per period
for PERIOD in 7D 30D 90D; do
  run_script "enrich_hyperliquid.mjs" "$PERIOD" 300
  run_script "enrich_gmx.mjs" "$PERIOD" 180
done

cleanup_chrome

# ========== Compute leaderboard ranks from snapshots ==========
log "START compute-leaderboard-local.mjs"
if gtimeout 300 node /Users/adelinewen/ranking-arena/scripts/compute-leaderboard-local.mjs >> "$LOG_DIR/compute-leaderboard.log" 2>&1; then
    log "OK    compute-leaderboard-local.mjs"
else
    log "FAIL  compute-leaderboard-local.mjs (exit $?)"
fi

log "=== Mac Mini cron done ==="
