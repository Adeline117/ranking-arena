#!/bin/bash
#
# 部署 Cloudflare Worker 代理
#
# 此脚本会:
# 1. 安装依赖
# 2. 部署 Worker 到 Cloudflare
# 3. 更新 .env 文件
#
# 使用前需要:
# 1. 安装 wrangler CLI: npm i -g wrangler
# 2. 登录 Cloudflare: wrangler login
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$PROJECT_ROOT/cloudflare-worker"

echo "========================================"
echo "部署 Cloudflare Worker 代理"
echo "========================================"
echo ""

# 检查 wrangler
if ! command -v wrangler &> /dev/null; then
    echo "⚠ wrangler 未安装"
    echo "请运行: npm i -g wrangler"
    exit 1
fi

# 检查登录状态
echo "📋 检查 Cloudflare 登录状态..."
if ! wrangler whoami &> /dev/null; then
    echo "⚠ 未登录 Cloudflare"
    echo "请运行: wrangler login"
    exit 1
fi

echo "✓ 已登录 Cloudflare"
echo ""

# 安装依赖
cd "$WORKER_DIR"
echo "📦 安装依赖..."
npm install

# 部署
echo ""
echo "🚀 部署 Worker..."
DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# 提取 Worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9-]+\.workers\.dev' | head -1)

if [ -z "$WORKER_URL" ]; then
    # 尝试从 wrangler.toml 获取名称构造 URL
    WORKER_NAME=$(grep 'name' wrangler.toml | head -1 | cut -d'"' -f2)
    if [ -n "$WORKER_NAME" ]; then
        echo ""
        echo "Worker 已部署，但无法自动获取 URL"
        echo "请在 Cloudflare Dashboard 查看 Worker URL"
        echo "然后手动添加到 .env:"
        echo "  CLOUDFLARE_PROXY_URL=https://${WORKER_NAME}.<your-account>.workers.dev"
    fi
    exit 0
fi

echo ""
echo "========================================"
echo "✅ 部署成功！"
echo "========================================"
echo ""
echo "Worker URL: $WORKER_URL"
echo ""

# 更新 .env
ENV_FILE="$PROJECT_ROOT/.env"
ENV_LOCAL="$PROJECT_ROOT/.env.local"

update_env() {
    local file=$1
    if [ -f "$file" ]; then
        if grep -q "CLOUDFLARE_PROXY_URL" "$file"; then
            # 更新现有配置
            sed -i.bak "s|CLOUDFLARE_PROXY_URL=.*|CLOUDFLARE_PROXY_URL=$WORKER_URL|" "$file"
            rm -f "${file}.bak"
            echo "✓ 已更新 $file"
        else
            # 添加新配置
            echo "" >> "$file"
            echo "# Cloudflare Worker 代理" >> "$file"
            echo "CLOUDFLARE_PROXY_URL=$WORKER_URL" >> "$file"
            echo "✓ 已添加到 $file"
        fi
    fi
}

if [ -f "$ENV_FILE" ]; then
    update_env "$ENV_FILE"
elif [ -f "$ENV_LOCAL" ]; then
    update_env "$ENV_LOCAL"
else
    echo "⚠ 未找到 .env 文件，请手动添加:"
    echo "  CLOUDFLARE_PROXY_URL=$WORKER_URL"
fi

echo ""
echo "========================================"
echo "📋 下一步"
echo "========================================"
echo ""
echo "1. 测试代理:"
echo "   curl $WORKER_URL/health"
echo ""
echo "2. 使用代理抓取数据:"
echo "   node scripts/import/import_via_proxy.mjs all ALL"
echo ""
echo "========================================"
