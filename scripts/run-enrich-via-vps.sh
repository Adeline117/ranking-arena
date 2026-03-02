#!/bin/bash
# 在 VPS 上运行 enrichment 脚本，避免本地 429

VPS_HOST="45.76.152.169"
SCRIPT_NAME=$1

if [ -z "$SCRIPT_NAME" ]; then
    echo "Usage: $0 <script_name>"
    echo "Example: $0 enrich-bitget-futures-wr-mdd.mjs"
    exit 1
fi

# 同步脚本到 VPS
rsync -av ~/ranking-arena/scripts/${SCRIPT_NAME} root@${VPS_HOST}:/root/arena/

# 在 VPS 上运行
ssh root@${VPS_HOST} "cd /root/arena && node ${SCRIPT_NAME}"
