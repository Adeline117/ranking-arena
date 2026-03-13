#!/bin/bash
# 验证NO_ENRICHMENT_PLATFORMS修复是否生效
# 
# 测试所有不支持enrichment的平台是否正确返回成功

set -e

BASE_URL="${VERCEL_URL:-https://ranking-arena.vercel.app}"
CRON_SECRET="${CRON_SECRET}"

if [ -z "$CRON_SECRET" ]; then
  echo "Error: CRON_SECRET环境变量未设置"
  exit 1
fi

echo "Testing NO_ENRICHMENT_PLATFORMS handling..."
echo "Base URL: $BASE_URL"
echo ""

# 不支持enrichment的平台列表
PLATFORMS=(
  "binance_web3"
  "okx_web3"
  "web3_bot"
  "bingx"
  "bybit"
  "bybit_spot"
  "bitfinex"
  "coinex"
  "xt"
  "bitmart"
  "btcc"
  "bitunix"
  "paradex"
  "okx_spot"
)

SUCCESS_COUNT=0
FAIL_COUNT=0

for platform in "${PLATFORMS[@]}"; do
  echo "Testing platform: $platform"
  
  response=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $CRON_SECRET" \
    "$BASE_URL/api/cron/enrich?platform=$platform&period=90D&limit=10")
  
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    # 检查响应是否包含 ok: true
    if echo "$body" | grep -q '"ok":true'; then
      echo "  ✅ SUCCESS (200 OK, ok: true)"
      ((SUCCESS_COUNT++))
    else
      echo "  ❌ FAIL (200 OK but ok: false)"
      echo "  Response: $body"
      ((FAIL_COUNT++))
    fi
  else
    echo "  ❌ FAIL (HTTP $http_code)"
    echo "  Response: $body"
    ((FAIL_COUNT++))
  fi
  
  echo ""
  sleep 0.5
done

echo "=================="
echo "Test Summary:"
echo "  Success: $SUCCESS_COUNT/${#PLATFORMS[@]}"
echo "  Failed:  $FAIL_COUNT/${#PLATFORMS[@]}"
echo "=================="

if [ $FAIL_COUNT -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
