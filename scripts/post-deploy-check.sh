#!/bin/bash
# Post-deploy smoke test — run after every Vercel deployment
# Usage: scripts/post-deploy-check.sh [base_url]
#
# This script tests the 5 critical paths. If ANY returns 500,
# the deployment should be rolled back immediately.

BASE="${1:-https://www.arenafi.org}"
PASS=0
FAIL=0

echo "🔍 Post-deploy check: $BASE"
echo ""

# 动态取排行第一名做 trader 详情页冒烟（固定 handle 会因数据下架变成死链，
# 如 /trader/soul 的 weex 数据 2026-06 已不存在 — 页面 200 但内容是 not-found）
TRADER_PATH="/trader/soul"
TOP=$(curl -s --max-time 15 "${BASE}/api/rankings?window=30d&limit=1" | python3 -c "
import json,sys
try:
    t=json.load(sys.stdin)['data']['traders'][0]
    print(f\"/trader/{t['trader_key']}?platform={t['platform']}\")
except Exception:
    pass" 2>/dev/null)
[ -n "$TOP" ] && TRADER_PATH="$TOP"

for path in \
  "/" \
  "$TRADER_PATH" \
  "/login" \
  "/pricing" \
  "/api/health"; do

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${BASE}${path}")
  # 000 = curl 层失败（DNS/超时抖动）— 重试一次再判定，避免误报回滚
  if [ "$STATUS" = "000" ]; then
    sleep 2
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${BASE}${path}")
  fi
  if [ "$STATUS" = "500" ] || [ "$STATUS" = "000" ]; then
    echo "❌ FAIL [$STATUS] $path"
    FAIL=$((FAIL+1))
  else
    echo "✅ PASS [$STATUS] $path"
    PASS=$((PASS+1))
  fi
done

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "🚨 $FAIL/$((PASS+FAIL)) FAILED — ROLL BACK DEPLOYMENT"
  echo "   Vercel Dashboard → Deployments → previous green deploy → Promote to Production"
  exit 1
else
  echo "✅ $PASS/$((PASS+FAIL)) passed — deployment is healthy"
  exit 0
fi
