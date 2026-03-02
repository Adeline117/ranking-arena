#!/bin/bash
# Rate Limit Bypass 脚本
# 通过 VPS 执行请求，避免本地 IP 被限流

VPS_HOST="45.76.152.169"
LOG_FILE="/tmp/vps_proxy.log"

# 使用方法: ./vps-proxy.sh <URL>
url="$1"

if [ -z "$url" ]; then
    echo "Usage: $0 <URL>"
    exit 1
fi

echo "$(date): Fetching $url via VPS" >> "$LOG_FILE"

# 通过 SSH 在 VPS 上执行 curl
ssh root@$VPS_HOST "curl -s -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' '$url'" 2>&1

exit_code=$?
echo "$(date): Exit code: $exit_code" >> "$LOG_FILE"

exit $exit_code
