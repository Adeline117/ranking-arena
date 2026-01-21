# 🚀 快速参考 - Antigravity 日常开发指令

## 📋 每日开始工作

```bash
# 1. 每日检查（自动拉取代码、检查环境等）
npm run daily-check

# 2. 启动开发服务器
npm run dev

# 3. 打开浏览器
open http://localhost:3000
```

## 🔄 常用开发命令

```bash
# 开发
npm run dev              # 启动开发服务器
npm run build            # 构建生产版本
npm run start            # 启动生产服务器（本地测试）

# 代码质量
npm run lint             # 检查代码
npm run lint:fix         # 自动修复
npm run type-check       # TypeScript 类型检查
npm run format           # 格式化代码

# 测试
npm run test             # 运行测试
npm run test:watch       # 监听模式测试
npm run test:coverage    # 测试覆盖率
npm run test:e2e         # E2E 测试

# 部署相关
npm run setup:antigravity  # Antigravity 自动设置和部署
npm run setup:dev         # 快速设置开发环境
```

## 🔐 Token 和权限配置

### 必需的 Tokens（Antigravity Dashboard 配置）

1. **Antigravity Token**
   - 权限：Read Projects, Write Deployments, Manage Environment Variables
   - 位置：Antigravity Dashboard → Settings → API Tokens

2. **Supabase Service Role Key**
   - 位置：Supabase Dashboard → Settings → API

3. **GitHub Secrets**（在 GitHub 仓库设置中）
   ```
   VERCEL_TOKEN
   ANTIGRAVITY_TOKEN
   ANTIGRAVITY_PROJECT_ID
   SUPABASE_SERVICE_ROLE_KEY
   UPSTASH_REDIS_REST_TOKEN
   CRON_SECRET
   ```

### 环境变量（.env.local）

```bash
# 核心配置（必需）
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Redis 缓存（推荐）
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Cron 任务安全
CRON_SECRET=

# 应用 URL
NEXT_PUBLIC_APP_URL=https://your-app.antigravity.com

# 可选配置
STRIPE_SECRET_KEY=
SENTRY_DSN=
PROXY_LIST=
```

## 🚀 部署流程

### 自动部署（GitHub Actions）

推送到 `main` 分支后自动触发：

```bash
git add .
git commit -m "feat: your changes"
git push origin main
```

### 手动部署

```bash
# 1. 构建
npm run build

# 2. 部署到 Antigravity
npm run setup:antigravity
```

## 🔍 调试和监控

```bash
# 查看日志（Antigravity CLI）
antigravity logs --project=your-project-id

# 健康检查
curl https://your-app.antigravity.com/api/health

# 检查 Cron 任务状态
curl https://your-app.antigravity.com/api/cron/fetch-traders
```

## 📊 数据抓取

```bash
# 抓取交易员详情
npm run scrape:details

# 强制更新所有数据
npm run scrape:details:force

# 手动触发特定平台
curl -X POST https://your-app.antigravity.com/api/cron/fetch-traders/binance_spot \
  -H "Authorization: Bearer $CRON_SECRET"
```

## 🐛 故障排除

### 构建失败
```bash
# 清理缓存
npm run clean
rm -rf node_modules .next
npm install
npm run build
```

### 类型错误
```bash
npm run type-check
```

### 环境变量问题
```bash
# 检查环境变量
npm run daily-check
```

## 📱 移动端

```bash
# 同步到原生项目
npx cap sync

# Android
npx cap open android

# iOS
npx cap open ios
```

## 🔗 有用的链接

- **Antigravity Dashboard**: https://dashboard.antigravity.com
- **GitHub Actions**: https://github.com/Tyche1107/ranking-arena/actions
- **Supabase Dashboard**: https://supabase.com/dashboard
- **项目文档**: `/docs` 目录

---

**快速帮助**: 运行 `npm run daily-check` 开始新的一天！
