#!/bin/bash
# Antigravity 自动化设置脚本

set -e

echo "🚀 Ranking Arena - Antigravity 自动化配置"
echo "=========================================="
echo ""

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. 验证环境变量
echo "📋 1. 检查必需的环境变量..."
required_vars=(
  "NEXT_PUBLIC_SUPABASE_URL"
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  "SUPABASE_SERVICE_ROLE_KEY"
)

missing_vars=()
for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo -e "${RED}  ❌ $var 未设置${NC}"
    missing_vars+=("$var")
  else
    echo -e "${GREEN}  ✅ $var 已设置${NC}"
  fi
done

if [ ${#missing_vars[@]} -gt 0 ]; then
  echo -e "${RED}错误: 以下环境变量未设置:${NC}"
  printf '  - %s\n' "${missing_vars[@]}"
  echo ""
  echo "💡 提示: 请设置环境变量或确保 .env.local 文件存在"
  exit 1
fi

# 2. 检查可选环境变量
echo ""
echo "📋 2. 检查可选的环境变量..."
optional_vars=(
  "ANTIGRAVITY_TOKEN"
  "ANTIGRAVITY_PROJECT_ID"
  "UPSTASH_REDIS_REST_URL"
  "UPSTASH_REDIS_REST_TOKEN"
  "STRIPE_SECRET_KEY"
  "SENTRY_DSN"
)

for var in "${optional_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo -e "${YELLOW}  ⚠️  $var 未设置（可选）${NC}"
  else
    echo -e "${GREEN}  ✅ $var 已设置${NC}"
  fi
done

# 3. 安装依赖
echo ""
echo "📦 3. 安装依赖..."
if [ ! -d "node_modules" ]; then
  npm ci
else
  echo "  ✅ node_modules 已存在"
  echo "  💡 如需更新，运行: npm ci"
fi

# 4. 运行测试
echo ""
echo "🧪 4. 运行测试..."
if npm run test 2>/dev/null; then
  echo -e "${GREEN}  ✅ 测试通过${NC}"
else
  echo -e "${YELLOW}  ⚠️  测试失败或未配置，继续部署...${NC}"
fi

# 5. 类型检查
echo ""
echo "🔍 5. 类型检查..."
if npm run type-check; then
  echo -e "${GREEN}  ✅ 类型检查通过${NC}"
else
  echo -e "${RED}  ❌ 类型检查失败${NC}"
  exit 1
fi

# 6. 构建项目
echo ""
echo "🏗️  6. 构建项目..."
if npm run build; then
  echo -e "${GREEN}  ✅ 构建成功${NC}"
else
  echo -e "${RED}  ❌ 构建失败${NC}"
  exit 1
fi

# 7. 部署到 Antigravity
echo ""
echo "🚀 7. 部署到 Antigravity..."

if [ -z "$ANTIGRAVITY_TOKEN" ] || [ -z "$ANTIGRAVITY_PROJECT_ID" ]; then
  echo -e "${YELLOW}  ⚠️  Antigravity Token 或 Project ID 未设置${NC}"
  echo "  💡 请设置环境变量或手动部署"
  exit 0
fi

# 检查 Antigravity CLI
if command -v antigravity &> /dev/null; then
  echo "  使用 Antigravity CLI 部署..."
  antigravity deploy --token=$ANTIGRAVITY_TOKEN --project=$ANTIGRAVITY_PROJECT_ID
elif command -v npx &> /dev/null; then
  echo "  尝试使用 npx 运行 Antigravity CLI..."
  npx -y @antigravity/cli deploy --token=$ANTIGRAVITY_TOKEN --project=$ANTIGRAVITY_PROJECT_ID
else
  echo -e "${YELLOW}  ⚠️  Antigravity CLI 未找到${NC}"
  echo "  💡 请手动部署或安装 CLI: npm install -g @antigravity/cli"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Antigravity 配置完成！${NC}"
echo ""
