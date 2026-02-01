#!/bin/bash
# 全平台自动刷新 — 8GB MacBook Air 优化版
# 每个平台独立子进程，OOM 杀一个不影响其他
# 用法: bash scripts/import/refresh.sh [api|browser|all]
cd "$(dirname "$0")/../.." || exit 1

MODE="${1:-all}"
PROXY="http://127.0.0.1:7890"
echo "🔄 $(date '+%Y-%m-%d %H:%M') mode=$MODE"

# Enable proxy
curl -s -X PATCH http://127.0.0.1:9090/configs -H 'Content-Type: application/json' -d '{"mode":"global"}' >/dev/null 2>&1
sleep 1

run() {
  local name="$1" cmd="$2" tmo="${3:-60}"
  echo -n "  $name... "
  local result
  result=$(perl -e "alarm $tmo; exec @ARGV" bash -c "$cmd" 2>&1 | tail -1)
  local code=$?
  if [ $code -eq 0 ] && [ -n "$result" ]; then echo "✅ $result"
  elif [ $code -eq 142 ]; then echo "⏰"
  else echo "❌"; fi
  sleep 2
}

kill_chrome() {
  pkill -9 -f "Chromium\|Google Chrome\|remote-debugging-port" 2>/dev/null
  sleep 3
}

# ============================================================
# API PLATFORMS (7) — curl/node, ~3 min total
# ============================================================
if [ "$MODE" = "api" ] || [ "$MODE" = "all" ]; then
  echo "📡 API (7):"
  run "OKX" "node scripts/import/import_okx_futures.mjs 2>/dev/null && echo done" 45
  run "HTX" "node scripts/import/archive/import_htx_enhanced.mjs 2>/dev/null && echo done" 45
  run "Gains" "node scripts/import/import_gains.mjs 2>/dev/null && echo done" 60

  curl -s -m 30 -x "$PROXY" https://stats-data.hyperliquid.xyz/Mainnet/leaderboard -o /tmp/hl.json 2>/dev/null
  run "Hyperliquid" "node scripts/import/_tmp_hl.js 2>/dev/null" 30

  curl -s -m 20 -x "$PROXY" -X POST https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql \
    -H 'Content-Type:application/json' \
    -d '{"query":"{accountStats(limit:2000,orderBy:realizedPnl_DESC){id wins losses realizedPnl maxCapital closedCount}}"}' \
    -o /tmp/gmx.json 2>/dev/null
  run "GMX" "node scripts/import/_tmp_gmx.js 2>/dev/null" 30

  run "BN-Futures" "node scripts/import/_tmp_bnf.js 2>/dev/null" 90
  run "BN-Spot" "node scripts/import/_tmp_bns.js 2>/dev/null" 90
fi

# ============================================================
# BROWSER PLATFORMS (11) — one Chrome at a time, ~20 min total
# ============================================================
if [ "$MODE" = "browser" ] || [ "$MODE" = "browser1" ] || [ "$MODE" = "all" ]; then
  echo "🌐 Batch 1 — Playwright + large platforms:"
  for PLAT in xt coinex; do
    kill_chrome
    run "$PLAT" "node scripts/import/browser-single.mjs $PLAT 2>/dev/null" 120
  done
  for PLAT in mexc kucoin bitget_s; do
    kill_chrome
    run "$PLAT" "node scripts/import/browser-real-chrome.mjs $PLAT 2>/dev/null" 120
  done
  # Bybit & Bitget-F: use SSR for deeper scrolling (more data)
  for PLAT in bybit bitget_f; do
    kill_chrome
    run "$PLAT" "node scripts/import/browser-ssr.mjs $PLAT 2>/dev/null" 130
  done
fi

if [ "$MODE" = "browser" ] || [ "$MODE" = "browser2" ] || [ "$MODE" = "all" ]; then
  echo "🌐 Batch 2 — small platforms + SSR:"
  for PLAT in phemex weex lbank; do
    kill_chrome
    run "$PLAT" "node scripts/import/browser-real-chrome.mjs $PLAT 2>/dev/null" 120
  done
  kill_chrome
  run "bingx" "node scripts/import/browser-ssr.mjs bingx 2>/dev/null" 130
  kill_chrome
fi

# Restore proxy
curl -s -X PATCH http://127.0.0.1:9090/configs -H 'Content-Type: application/json' -d '{"mode":"direct"}' >/dev/null 2>&1
echo "✅ 完成 $(date '+%H:%M')"
