#!/bin/bash
# 每日开发前检查脚本

set -e

echo "🌅 Ranking Arena - 每日开发检查"
echo "=================================="
echo ""

# 1. 检查 Git 状态
echo "📊 1. 检查 Git 状态..."
git status --short
echo ""

# 2. 拉取最新代码
echo "⬇️  2. 拉取最新代码..."
git pull origin main || echo "⚠️  无法拉取代码，可能没有远程分支"
echo ""

# 3. 检查环境变量
echo "🔐 3. 检查环境变量..."
if [ ! -f .env.local ]; then
  echo "⚠️  警告: .env.local 不存在"
  if [ -f .env.example ]; then
    echo "💡 提示: 可以运行 cp .env.example .env.local"
  fi
else
  echo "✅ .env.local 存在"
  # 检查关键环境变量
  source .env.local 2>/dev/null || true
  required_vars=(
    "NEXT_PUBLIC_SUPABASE_URL"
    "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  )
  missing=0
  for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
      echo "  ❌ $var 未设置"
      missing=1
    else
      echo "  ✅ $var 已设置"
    fi
  done
  if [ $missing -eq 1 ]; then
    echo "⚠️  部分环境变量缺失"
  fi
fi
echo ""

# 4. 检查 Node.js 版本
echo "🟢 4. 检查 Node.js 版本..."
node_version=$(node -v)
echo "  当前版本: $node_version"
required_version="v20"
if [[ "$node_version" < "$required_version" ]]; then
  echo "  ⚠️  建议使用 Node.js $required_version 或更高版本"
else
  echo "  ✅ Node.js 版本符合要求"
fi
echo ""

# 5. 检查依赖
echo "📦 5. 检查依赖..."
if [ ! -d "node_modules" ]; then
  echo "  ⚠️  node_modules 不存在，需要运行 npm install"
else
  echo "  ✅ node_modules 存在"
  # 检查是否需要更新
  if [ -f "package-lock.json" ]; then
    echo "  💡 运行 npm ci 确保依赖同步"
  fi
fi
echo ""

# 6. 类型检查（可选）
if command -v npm &> /dev/null; then
  echo "🔍 6. 快速类型检查..."
  npm run type-check 2>&1 | head -20 || echo "  ⚠️  类型检查失败或未配置"
  echo ""
fi

# 7. 总结
echo "=================================="
echo "✅ 检查完成！"
echo ""
echo "🚀 下一步:"
echo "  1. 如有环境变量缺失，请编辑 .env.local"
echo "  2. 如有依赖问题，运行: npm install"
echo "  3. 启动开发服务器: npm run dev"
echo ""
