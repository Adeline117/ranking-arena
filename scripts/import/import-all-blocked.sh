#!/bin/bash
# 依次导入所有被封平台 - 每个平台独立进程，防止内存累积
cd "$(dirname "$0")/../.."

echo "🚀 导入所有被封平台"
echo "================================"

for platform in bitget mexc kucoin coinex; do
  echo ""
  echo "▶ 开始: $platform"
  node scripts/import/browser-import-single.mjs "$platform" 2>&1 &
  PID=$!
  ( sleep 120 && kill $PID 2>/dev/null ) &
  TIMER=$!
  wait $PID 2>/dev/null
  status=$?
  if [ $status -eq 0 ]; then
    echo "✅ $platform 完成"
  elif [ $status -eq 124 ]; then
    echo "⏰ $platform 超时(120s)"
  else
    echo "❌ $platform 失败 (code $status)"
  fi
  sleep 3
done

# Restore proxy
curl -s -X PATCH http://127.0.0.1:9090/configs -H 'Content-Type: application/json' -d '{"mode":"direct"}' > /dev/null 2>&1

echo ""
echo "================================"
echo "✅ 全部完成"
