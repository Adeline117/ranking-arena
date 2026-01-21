#!/bin/bash

# Vercel部署脚本
# 使用方法:
# 1. 使用Token: VERCEL_TOKEN=your_token ./scripts/deploy-vercel.sh
# 2. 使用部署钩子: VERCEL_DEPLOY_HOOK_URL=your_hook_url ./scripts/deploy-vercel.sh
# 3. 如果已登录: ./scripts/deploy-vercel.sh

set -e

echo "🚀 开始部署到Vercel..."

# 检查是否提供了token
if [ -n "$VERCEL_TOKEN" ]; then
    echo "✅ 使用提供的Vercel Token"
    npx vercel deploy --prod --token="$VERCEL_TOKEN"
    exit 0
fi

# 检查是否提供了部署钩子URL
if [ -n "$VERCEL_DEPLOY_HOOK_URL" ]; then
    echo "✅ 使用部署钩子URL"
    curl -X POST "$VERCEL_DEPLOY_HOOK_URL"
    echo ""
    echo "✅ 部署请求已发送"
    exit 0
fi

# 尝试使用已保存的认证信息
echo "⚠️  未提供Token或部署钩子，尝试使用已保存的认证信息..."
if npx vercel whoami > /dev/null 2>&1; then
    echo "✅ 已找到认证信息，开始部署..."
    npx vercel deploy --prod
    exit 0
else
    echo "❌ 错误: 需要Vercel认证"
    echo ""
    echo "请选择以下方式之一:"
    echo "1. 设置环境变量 VERCEL_TOKEN=your_token"
    echo "2. 设置环境变量 VERCEL_DEPLOY_HOOK_URL=your_hook_url"
    echo "3. 运行 'npx vercel login' 进行交互式登录"
    echo ""
    echo "获取Token: https://vercel.com/account/tokens"
    echo "创建部署钩子: Vercel Dashboard -> Project Settings -> Deploy Hooks"
    exit 1
fi
