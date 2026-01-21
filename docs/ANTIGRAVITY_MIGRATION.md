# Antigravity 迁移与自动化配置指南

## 🚀 迁移检查清单

### 1. 环境变量和 Tokens 配置

#### 必需的环境变量（在 Antigravity Dashboard 中配置）

```bash
# Supabase 配置
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Redis 缓存 (Upstash)
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-redis-token

# Stripe 支付 (可选)
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_xxx

# Sentry 错误监控 (可选)
NEXT_PUBLIC_SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project
SENTRY_AUTH_TOKEN=your-sentry-token

# Cron 任务安全密钥
CRON_SECRET=your-random-secret-key-here

# 应用 URL
NEXT_PUBLIC_APP_URL=https://your-app.antigravity.com

# 代理池配置（用于数据抓取，避免 IP 封禁）
PROXY_LIST=http://proxy1:port|user|pass,http://proxy2:port|user|pass

# Antigravity 特定配置
ANTIGRAVITY_TOKEN=your-antigravity-api-token
ANTIGRAVITY_PROJECT_ID=your-project-id
```

### 2. GitHub Secrets 配置（用于 CI/CD）

在 GitHub 仓库设置中添加以下 Secrets：

```
VERCEL_TOKEN                    # Vercel API Token（如果使用）
ANTIGRAVITY_TOKEN              # Antigravity API Token
ANTIGRAVITY_PROJECT_ID         # Antigravity 项目 ID
SUPABASE_SERVICE_ROLE_KEY      # Supabase 服务密钥
UPSTASH_REDIS_REST_TOKEN       # Redis Token
STRIPE_SECRET_KEY              # Stripe 密钥（如使用）
SENTRY_AUTH_TOKEN              # Sentry Token（如使用）
CRON_SECRET                    # Cron 任务密钥
```

### 3. Antigravity 权限配置

在 Antigravity Dashboard 中需要开启的权限：

- ✅ **代码仓库访问权限** (Read/Write)
- ✅ **环境变量管理权限**
- ✅ **部署权限** (自动部署)
- ✅ **Cron 任务执行权限**
- ✅ **日志查看权限**
- ✅ **域名管理权限**
- ✅ **Webhook 接收权限**

---

## 🤖 自动化工作流配置

### GitHub Actions 工作流（Antigravity 版本）

创建 `.github/workflows/deploy-antigravity.yml`:

```yaml
name: Deploy to Antigravity

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    name: Deploy to Antigravity
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - run: npm ci
      
      - name: Run tests
        run: npm run test
        continue-on-error: true
      
      - name: Type check
        run: npm run type-check
      
      - name: Lint
        run: npm run lint
        continue-on-error: true
      
      - name: Build
        run: npm run build
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
      
      - name: Deploy to Antigravity
        env:
          ANTIGRAVITY_TOKEN: ${{ secrets.ANTIGRAVITY_TOKEN }}
          ANTIGRAVITY_PROJECT_ID: ${{ secrets.ANTIGRAVITY_PROJECT_ID }}
        run: |
          # 使用 Antigravity CLI 部署
          npm install -g @antigravity/cli
          antigravity deploy --token=$ANTIGRAVITY_TOKEN --project=$ANTIGRAVITY_PROJECT_ID
```

### 自动化脚本集合

创建 `scripts/antigravity-setup.sh`:

```bash
#!/bin/bash
# Antigravity 自动化设置脚本

set -e

echo "🚀 开始 Antigravity 自动化配置..."

# 1. 验证环境变量
echo "📋 检查环境变量..."
required_vars=(
  "NEXT_PUBLIC_SUPABASE_URL"
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  "SUPABASE_SERVICE_ROLE_KEY"
  "ANTIGRAVITY_TOKEN"
  "ANTIGRAVITY_PROJECT_ID"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "❌ 错误: $var 未设置"
    exit 1
  fi
done

echo "✅ 环境变量检查通过"

# 2. 安装依赖
echo "📦 安装依赖..."
npm ci

# 3. 运行测试
echo "🧪 运行测试..."
npm run test || echo "⚠️  测试失败，继续部署..."

# 4. 类型检查
echo "🔍 类型检查..."
npm run type-check

# 5. 构建项目
echo "🏗️  构建项目..."
npm run build

# 6. 部署到 Antigravity
echo "🚀 部署到 Antigravity..."
if command -v antigravity &> /dev/null; then
  antigravity deploy --token=$ANTIGRAVITY_TOKEN --project=$ANTIGRAVITY_PROJECT_ID
else
  echo "⚠️  Antigravity CLI 未安装，跳过自动部署"
fi

echo "✅ 配置完成！"
```

---

## 📝 日常开发习惯指令

### 每日启动检查清单

创建 `scripts/daily-check.sh`:

```bash
#!/bin/bash
# 每日开发前检查脚本

echo "🌅 开始每日开发检查..."

# 1. 检查 Git 状态
echo "📊 Git 状态:"
git status --short

# 2. 拉取最新代码
echo "⬇️  拉取最新代码..."
git pull origin main

# 3. 检查环境变量
echo "🔐 检查环境变量..."
if [ ! -f .env.local ]; then
  echo "⚠️  警告: .env.local 不存在"
else
  echo "✅ .env.local 存在"
fi

# 4. 更新依赖
echo "📦 更新依赖..."
npm install

# 5. 运行类型检查
echo "🔍 类型检查..."
npm run type-check || echo "❌ 类型检查失败"

# 6. 运行测试
echo "🧪 运行测试..."
npm run test || echo "⚠️  测试失败"

# 7. 启动开发服务器
echo "🚀 启动开发服务器..."
echo "运行: npm run dev"
```

### 提交前自动检查

创建 `.husky/pre-commit` (需要先安装 husky):

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# 运行类型检查
npm run type-check

# 运行测试
npm run test

# 运行 Lint
npm run lint:fix

# 格式化代码
npm run format
```

---

## 🔄 自动化任务配置

### Cron 任务迁移到 Antigravity

Antigravity 通常支持通过 Dashboard 或配置文件设置 Cron 任务。

如果支持 `antigravity.json` 或类似配置：

```json
{
  "crons": [
    {
      "path": "/api/cron/fetch-hot-traders",
      "schedule": "*/15 * * * *",
      "timezone": "UTC"
    },
    {
      "path": "/api/cron/fetch-followed-traders",
      "schedule": "0 * * * *",
      "timezone": "UTC"
    },
    {
      "path": "/api/cron/check-data-freshness",
      "schedule": "0 */3 * * *",
      "timezone": "UTC"
    },
    {
      "path": "/api/cron/fetch-traders/binance_spot",
      "schedule": "5 */4 * * *",
      "timezone": "UTC"
    }
  ]
}
```

### 数据抓取自动化

确保以下端点可以自动触发：

```bash
# 手动触发抓取（用于测试）
curl -X POST https://your-app.antigravity.com/api/cron/fetch-traders \
  -H "Authorization: Bearer $CRON_SECRET"

# 检查抓取状态
curl https://your-app.antigravity.com/api/cron/fetch-traders
```

---

## 🔐 Token 获取指南

### 1. Antigravity Token

1. 登录 Antigravity Dashboard
2. 进入 Settings → API Tokens
3. 点击 "Create New Token"
4. 权限选择：
   - ✅ Read Projects
   - ✅ Write Deployments
   - ✅ Read/Write Environment Variables
   - ✅ Manage Cron Jobs

### 2. Supabase Token

```bash
# Service Role Key (在 Supabase Dashboard)
# Settings → API → service_role key

# 建议创建专门的 API Key 用于自动化
```

### 3. GitHub Personal Access Token

1. GitHub → Settings → Developer settings → Personal access tokens
2. 权限选择：
   - ✅ repo (完整仓库权限)
   - ✅ workflow (GitHub Actions)
   - ✅ admin:repo_hook (Webhooks)

---

## 🛠️ 开发环境快速设置

创建 `scripts/setup-dev.sh`:

```bash
#!/bin/bash
# 快速设置开发环境

echo "🔧 设置开发环境..."

# 1. 复制环境变量模板
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "✅ 已创建 .env.local，请填写必要的环境变量"
else
  echo "ℹ️  .env.local 已存在"
fi

# 2. 安装依赖
npm install

# 3. 设置 Git hooks (如果使用 husky)
# npm run prepare

# 4. 初始化 Supabase (如果需要)
# npx supabase init

echo "✅ 开发环境设置完成！"
echo "📝 下一步: 编辑 .env.local 填写环境变量"
echo "🚀 然后运行: npm run dev"
```

---

## 📊 监控和日志

### 健康检查端点

确保以下端点可用：

```typescript
// app/api/health/route.ts
export async function GET() {
  return Response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    services: {
      supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      redis: !!process.env.UPSTASH_REDIS_REST_URL,
      sentry: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    }
  })
}
```

### 自动化监控脚本

```bash
#!/bin/bash
# 监控脚本 - 检查服务健康状态

APP_URL=${APP_URL:-"https://your-app.antigravity.com"}

echo "🔍 检查服务健康状态..."

# 检查主应用
response=$(curl -s -o /dev/null -w "%{http_code}" "$APP_URL/api/health")
if [ "$response" -eq 200 ]; then
  echo "✅ 主应用正常"
else
  echo "❌ 主应用异常 (HTTP $response)"
fi

# 检查数据库连接
# 可以添加更多检查...
```

---

## 🎯 快速命令参考

```bash
# 开发
npm run dev              # 启动开发服务器
npm run build            # 构建生产版本
npm run start            # 启动生产服务器

# 代码质量
npm run lint             # 检查代码
npm run lint:fix         # 自动修复
npm run type-check       # TypeScript 检查
npm run format           # 格式化代码

# 测试
npm run test             # 运行测试
npm run test:watch       # 监听模式测试
npm run test:e2e         # E2E 测试

# 部署
npm run deploy           # 部署到 Antigravity（如果配置了）

# 数据抓取
npm run scrape:details   # 抓取交易员详情

# 数据库
npm run db:migrate       # 运行数据库迁移（如果配置了）
```

---

## 📱 移动端构建

如果使用 Capacitor：

```bash
# 同步 Web 到原生项目
npx cap sync

# Android
npx cap open android

# iOS
npx cap open ios
```

---

## ✅ 迁移验证清单

- [ ] 环境变量已全部配置
- [ ] GitHub Secrets 已设置
- [ ] Antigravity Token 已生成并配置权限
- [ ] CI/CD 工作流已更新
- [ ] Cron 任务已迁移
- [ ] 域名已配置
- [ ] SSL 证书已启用
- [ ] 监控和日志已设置
- [ ] 数据库迁移已完成
- [ ] 测试通过
- [ ] 生产环境部署成功

---

## 🆘 故障排除

### 常见问题

1. **部署失败**
   ```bash
   # 检查日志
   antigravity logs --project=your-project-id
   
   # 检查环境变量
   antigravity env list --project=your-project-id
   ```

2. **Cron 任务不执行**
   - 检查 Cron 配置
   - 验证 CRON_SECRET
   - 查看任务执行日志

3. **数据库连接失败**
   - 检查 Supabase URL 和密钥
   - 验证网络连接
   - 检查防火墙设置

---

**最后更新**: $(date)
**维护者**: Your Team
