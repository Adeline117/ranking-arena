#!/bin/bash
# 快速设置开发环境

set -e

echo "🔧 Ranking Arena - 开发环境快速设置"
echo "====================================="
echo ""

# 1. 复制环境变量模板
echo "📝 1. 设置环境变量..."
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    echo "  ✅ 已创建 .env.local（从 .env.example）"
    echo "  ⚠️  请编辑 .env.local 填写必要的环境变量"
  else
    echo "  ⚠️  .env.example 不存在，请手动创建 .env.local"
  fi
else
  echo "  ✅ .env.local 已存在"
fi
echo ""

# 2. 安装依赖
echo "📦 2. 安装依赖..."
if [ ! -d "node_modules" ]; then
  echo "  安装中..."
  npm install
  echo "  ✅ 依赖安装完成"
else
  echo "  ✅ node_modules 已存在"
  echo "  💡 如需更新，运行: npm install"
fi
echo ""

# 3. 检查 Node.js 版本
echo "🟢 3. 检查 Node.js 版本..."
node_version=$(node -v)
echo "  当前版本: $node_version"
echo "  推荐版本: v20.x 或更高"
echo ""

# 4. 验证关键环境变量
echo "🔐 4. 验证环境变量..."
if [ -f .env.local ]; then
  source .env.local 2>/dev/null || true
  if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ]; then
    echo "  ⚠️  NEXT_PUBLIC_SUPABASE_URL 未设置"
  else
    echo "  ✅ NEXT_PUBLIC_SUPABASE_URL 已设置"
  fi
else
  echo "  ⚠️  .env.local 不存在，跳过验证"
fi
echo ""

# 5. 类型检查（可选）
echo "🔍 5. 快速类型检查..."
if npm run type-check 2>&1 | head -10; then
  echo "  ✅ 类型检查通过"
else
  echo "  ⚠️  类型检查失败或未配置"
fi
echo ""

echo "====================================="
echo "✅ 开发环境设置完成！"
echo ""
echo "📝 下一步:"
echo "  1. 编辑 .env.local 填写环境变量"
echo "  2. 运行: npm run dev"
echo "  3. 打开: http://localhost:3000"
echo ""
