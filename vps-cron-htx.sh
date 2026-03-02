#!/bin/bash
# VPS Cron Script: HTX Futures Data Fetch
# 部署到 Singapore VPS (45.76.152.169)
# 运行频率: 每6小时 (Group D)

set -e

# 环境变量
CRON_SECRET="${CRON_SECRET:-arena-cron-secret-2025}"
API_ENDPOINT="${API_ENDPOINT:-https://ranking-arena.vercel.app}"

# 日志目录
LOG_DIR="/var/log/ranking-arena"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/htx-futures-$(date +%Y%m%d).log"

# 函数：记录日志
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# 开始执行
log "========================================="
log "开始抓取 HTX Futures 数据"

# 调用API
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X GET \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$API_ENDPOINT/api/cron/fetch-traders/htx_futures")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

log "HTTP状态码: $HTTP_CODE"

if [ "$HTTP_CODE" -eq 200 ]; then
  log "✅ 抓取成功"
  log "响应: $BODY"
  
  # 解析结果
  DURATION=$(echo "$BODY" | jq -r '.duration // "N/A"')
  SAVED_7D=$(echo "$BODY" | jq -r '.periods."7D".saved // 0')
  SAVED_30D=$(echo "$BODY" | jq -r '.periods."30D".saved // 0')
  SAVED_90D=$(echo "$BODY" | jq -r '.periods."90D".saved // 0')
  
  log "耗时: ${DURATION}ms"
  log "保存数据: 7D=$SAVED_7D, 30D=$SAVED_30D, 90D=$SAVED_90D"
else
  log "❌ 抓取失败"
  log "错误响应: $BODY"
  exit 1
fi

log "========================================="
log ""
