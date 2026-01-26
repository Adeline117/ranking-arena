#!/bin/bash
# Binance 数据自动抓取脚本
# 使用 launchd 定时运行

cd "$(dirname "$0")/.."

# 加载环境变量 (从 .env.local 文件)
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

# 验证必要的环境变量
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "Error: SUPABASE_SERVICE_ROLE_KEY not set" >&2
  exit 1
fi

# 记录日志
LOG_FILE="$HOME/ranking-arena-scrape.log"
echo "========================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始 Binance 抓取" >> "$LOG_FILE"

# 运行抓取脚本
node scripts/local-scrape.mjs >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 抓取完成" >> "$LOG_FILE"
