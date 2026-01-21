# 🔐 Antigravity Tokens 和权限配置清单

## 📋 必需 Token 列表

### 1. Antigravity API Token ⭐ 核心

**获取方式**：
1. 登录 Antigravity Dashboard
2. Settings → API Tokens → Create New Token

**所需权限**：
- ✅ **Read Projects** - 读取项目信息
- ✅ **Write Deployments** - 创建和管理部署
- ✅ **Read/Write Environment Variables** - 管理环境变量
- ✅ **Manage Cron Jobs** - 管理定时任务
- ✅ **Read Logs** - 查看日志
- ✅ **Manage Domains** - 管理域名（如需要）

**配置位置**：
- GitHub Secrets: `ANTIGRAVITY_TOKEN`
- Antigravity Dashboard: Environment Variables
- 本地: `.env.local` (仅开发使用)

---

### 2. Antigravity Project ID ⭐ 核心

**获取方式**：
- Antigravity Dashboard → Your Project → Settings → Project ID

**配置位置**：
- GitHub Secrets: `ANTIGRAVITY_PROJECT_ID`
- 环境变量: `ANTIGRAVITY_PROJECT_ID`

---

### 3. Supabase Service Role Key ⭐ 核心

**获取方式**：
- Supabase Dashboard → Settings → API → service_role key

**权限范围**：
- ✅ 绕过 Row Level Security (RLS)
- ✅ 访问所有表和数据
- ⚠️ **安全警告**: 仅在服务端使用，不要暴露给客户端

**配置位置**：
- GitHub Secrets: `SUPABASE_SERVICE_ROLE_KEY`
- Antigravity Environment Variables: `SUPABASE_SERVICE_ROLE_KEY`
- 本地: `.env.local` (不提交到 Git)

---

### 4. Supabase Public Keys ⭐ 核心

**获取方式**：
- Supabase Dashboard → Settings → API

**包含**：
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase 项目 URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - 匿名访问密钥（客户端安全）

**配置位置**：
- GitHub Secrets: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Antigravity Environment Variables
- 本地: `.env.local`

---

### 5. Upstash Redis Token ⭐ 推荐

**获取方式**：
- Upstash Dashboard → Your Database → REST API → Token

**用途**：
- 缓存 API 响应
- 限流控制
- 会话存储

**配置位置**：
- GitHub Secrets: `UPSTASH_REDIS_REST_TOKEN`
- Antigravity Environment Variables: `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL`
- 本地: `.env.local`

---

### 6. Cron Secret ⭐ 必需

**生成方式**：
```bash
# 生成随机密钥
openssl rand -hex 32
# 或
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**用途**：
- 保护 Cron 端点免遭未授权访问
- 验证定时任务的请求来源

**配置位置**：
- GitHub Secrets: `CRON_SECRET`
- Antigravity Environment Variables: `CRON_SECRET`
- 本地: `.env.local`

---

### 7. Stripe Keys (可选) 💳

**获取方式**：
- Stripe Dashboard → Developers → API keys

**包含**：
- `STRIPE_SECRET_KEY` - 服务端密钥 (sk_live_xxx 或 sk_test_xxx)
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` - 客户端密钥
- `STRIPE_WEBHOOK_SECRET` - Webhook 签名密钥

**权限**：
- ✅ Read and Write charges
- ✅ Read and Write customers
- ✅ Read and Write subscriptions
- ✅ Read and Write webhooks

**配置位置**：
- GitHub Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Antigravity Environment Variables
- 本地: `.env.local`

---

### 8. Sentry Tokens (可选) 🐛

**获取方式**：
- Sentry Dashboard → Settings → Account → Auth Tokens

**包含**：
- `SENTRY_AUTH_TOKEN` - 用于上传 source maps
- `NEXT_PUBLIC_SENTRY_DSN` - 客户端 DSN
- `SENTRY_DSN` - 服务端 DSN

**权限**：
- ✅ project:read
- ✅ project:write
- ✅ project:releases

**配置位置**：
- GitHub Secrets: `SENTRY_AUTH_TOKEN`
- Antigravity Environment Variables: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`
- 本地: `.env.local`

---

### 9. GitHub Personal Access Token (可选) 🔄

**获取方式**：
- GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)

**所需权限**：
- ✅ `repo` - 完整仓库访问权限
- ✅ `workflow` - GitHub Actions 权限
- ✅ `admin:repo_hook` - Webhook 管理

**用途**：
- GitHub Actions 自动化
- Webhook 集成

**配置位置**：
- GitHub Secrets: `GH_TOKEN` 或 `GITHUB_TOKEN`
- 本地: `.env.local` (可选)

---

### 10. Proxy Pool (可选) 🌐

**格式**：
```
PROXY_LIST=http://proxy1:port|user|pass,http://proxy2:port|user|pass
```

**用途**：
- 数据抓取时避免 IP 封禁
- 轮换 IP 地址

**配置位置**：
- Antigravity Environment Variables: `PROXY_LIST`
- Worker 环境变量 (如使用独立 Worker)

---

## 🔑 GitHub Secrets 完整清单

在 GitHub 仓库 (`Tyche1107/ranking-arena`) → Settings → Secrets and variables → Actions 中添加：

```
# Antigravity
ANTIGRAVITY_TOKEN=xxxxxxxxxxxxx
ANTIGRAVITY_PROJECT_ID=proj_xxxxxxxxxxxxx

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Redis
UPSTASH_REDIS_REST_URL=https://xxxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXXAASQgYjk4YzQ...

# Security
CRON_SECRET=your-random-secret-key-32-chars-minimum

# Stripe (可选)
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxxx

# Sentry (可选)
SENTRY_AUTH_TOKEN=xxxxxxxxxxxxx
SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project

# Vercel (如果仍使用)
VERCEL_TOKEN=xxxxxxxxxxxxx

# App URL
NEXT_PUBLIC_APP_URL=https://your-app.antigravity.com
```

---

## 🔐 Antigravity Dashboard 环境变量配置

在 Antigravity Dashboard → Your Project → Environment Variables 中配置：

### Production 环境：
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CRON_SECRET
NEXT_PUBLIC_APP_URL
STRIPE_SECRET_KEY (可选)
STRIPE_WEBHOOK_SECRET (可选)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (可选)
SENTRY_DSN (可选)
NEXT_PUBLIC_SENTRY_DSN (可选)
SENTRY_ORG (可选)
SENTRY_PROJECT (可选)
PROXY_LIST (可选)
```

### Preview 环境：
- 可以复用 Production 的变量，或创建单独的测试环境变量

---

## ✅ 权限配置检查清单

### Antigravity Dashboard 权限：
- [ ] 项目访问权限（Owner/Admin）
- [ ] 环境变量读写权限
- [ ] 部署权限
- [ ] Cron 任务管理权限
- [ ] 日志查看权限
- [ ] 域名管理权限（如需要）

### GitHub 权限：
- [ ] 仓库写入权限
- [ ] GitHub Actions 权限
- [ ] Secrets 管理权限

### Supabase 权限：
- [ ] 项目 Owner 或 Admin
- [ ] API 密钥访问权限
- [ ] 数据库管理权限

### 第三方服务：
- [ ] Upstash Redis 访问权限
- [ ] Stripe 账户管理权限（如使用）
- [ ] Sentry 项目访问权限（如使用）

---

## 🔒 安全最佳实践

1. **永远不要提交敏感 Token 到 Git**
   - 所有 `.env` 文件已在 `.gitignore` 中
   - 只提交 `.env.example` 作为模板

2. **定期轮换 Token**
   - 建议每 3-6 个月轮换一次
   - 特别是服务端密钥

3. **最小权限原则**
   - 只授予必要的权限
   - 使用不同权限级别的 Token 用于不同场景

4. **环境隔离**
   - Production 和 Development 使用不同的密钥
   - 测试环境使用测试密钥（如 Stripe test keys）

5. **监控和审计**
   - 定期检查 Token 使用日志
   - 发现异常使用立即撤销 Token

---

## 📝 Token 管理脚本

```bash
# 检查环境变量是否设置
npm run daily-check

# 验证 Token 有效性（自定义脚本）
node scripts/verify-tokens.mjs
```

---

**最后更新**: 2025-01-21
**维护者**: Development Team
