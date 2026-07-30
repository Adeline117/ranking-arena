#!/bin/bash
# Post-deploy smoke test — run after every Vercel deployment
# Usage: scripts/post-deploy-check.sh [base_url] [expected_full_sha]
#
# This script verifies transport, release identity, and the B2C ranking product.
# A deployment is not healthy merely because its pages avoid HTTP 500.

BASE="${1:-https://www.arenafi.org}"
EXPECTED_SHA="${2:-}"
PASS=0
FAIL=0

echo "🔍 Post-deploy check: $BASE"
echo ""

check_path() {
  local path="$1"
  STATUS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 \
    --retry 2 --retry-all-errors --retry-delay 1 "${BASE}${path}" || true)
  case "$STATUS" in
    2??|3??)
      echo "✅ PASS [$STATUS] $path"
      PASS=$((PASS+1))
      ;;
    *)
      echo "❌ FAIL [${STATUS:-000}] $path"
      FAIL=$((FAIL+1))
      ;;
  esac
}

# 动态取当前公开榜第一名做 trader 详情页冒烟。固定 handle 会在来源下架后
# 变成 200 not-found；取样 API 不可用或为空本身就是 discovery hard failure，
# 因此这里 fail closed，不回退到历史 fixture。
TOP_JSON=$(curl -fsS --max-time 20 --retry 2 --retry-all-errors --retry-delay 1 \
  "${BASE}/api/rankings?window=30d&limit=1&_release_check=$(date +%s)" || true)
TRADER_PATH=$(printf '%s' "$TOP_JSON" | python3 -c '
import json,sys
from urllib.parse import quote
try:
    trader=json.load(sys.stdin)["data"]["traders"][0]
    key=trader["trader_key"]
    source=trader["platform"]
    if not isinstance(key,str) or not key or not isinstance(source,str) or not source:
        raise ValueError("invalid ranking sample identity")
    key=quote(key, safe="")
    source=quote(source, safe="")
    print(f"/trader/{key}?source={source}")
except Exception:
    pass
' 2>/dev/null)
if [ -n "$TRADER_PATH" ]; then
  check_path "$TRADER_PATH"
else
  echo "❌ FAIL current ranking sample is empty or unreadable"
  FAIL=$((FAIL+1))
fi

for path in \
  "/" \
  "/login" \
  "/pricing" \
  "/api/health"; do
  check_path "$path"
done

# Release identity: CLI deployments do not always populate VERCEL_GIT_COMMIT_SHA,
# so deploy-gate injects ARENA_RELEASE_SHA at build and runtime. A mismatched SHA
# means the domain points at a different deployment than the one CI approved.
HEALTH_JSON=$(curl -fsS --max-time 20 --retry 2 --retry-all-errors --retry-delay 1 \
  "${BASE}/api/health?_release_check=$(date +%s)" || true)
DEPLOYED_SHA=$(printf '%s' "$HEALTH_JSON" | python3 -c '
import json,sys
try: print(json.load(sys.stdin).get("commit", ""))
except Exception: print("")
' 2>/dev/null)

HEALTH_VALIDATION_ERROR=$(mktemp)
if HEALTH_DECISION=$(printf '%s' "$HEALTH_JSON" \
  | node scripts/ci/validate-release-health.mjs 2>"$HEALTH_VALIDATION_ERROR"); then
  echo "✅ PASS release health ${HEALTH_DECISION}"
  PASS=$((PASS+1))
else
  HEALTH_FAILURE=$(cat "$HEALTH_VALIDATION_ERROR" 2>/dev/null || true)
  echo "❌ FAIL release health ${HEALTH_FAILURE:-unreadable}"
  FAIL=$((FAIL+1))
fi
rm -f "$HEALTH_VALIDATION_ERROR"

if [ -n "$EXPECTED_SHA" ]; then
  if [ "$DEPLOYED_SHA" = "$EXPECTED_SHA" ]; then
    echo "✅ PASS release SHA ${DEPLOYED_SHA:0:9}"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL release SHA expected=${EXPECTED_SHA:0:9} actual=${DEPLOYED_SHA:-unknown}"
    FAIL=$((FAIL+1))
  fi
fi

# Business acceptance: these three boards are the primary B2C discovery paths.
# This catches successful builds that still serve empty cached/data results.
for token in BTC ETH SOL; do
  BODY=$(curl -fsS --max-time 20 --retry 2 --retry-all-errors --retry-delay 1 \
    "${BASE}/api/rankings/by-token?token=${token}&period=90D&limit=1&_release_check=$(date +%s)" || true)
  COUNT=$(printf '%s' "$BODY" | python3 -c '
import json,sys
try:
    body=json.load(sys.stdin)
    print(len(body.get("traders") or []))
except Exception:
    print(-1)
' 2>/dev/null)
  if [ "${COUNT:-0}" -gt 0 ] 2>/dev/null; then
    echo "✅ PASS ${token} token board (${COUNT} row sampled)"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL ${token} token board is empty or unreadable"
    FAIL=$((FAIL+1))
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
