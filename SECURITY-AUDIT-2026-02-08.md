# Arena 安全审计报告
**日期**: 2026-02-08  
**审计范围**: API routes, Cron jobs, RLS, 环境变量, XSS, SQL注入, 硬编码敏感信息, CORS

---

## 🔴 严重问题 (已修复)

### 1. `chat/upload` — 用户身份伪造漏洞
**文件**: `app/api/chat/upload/route.ts`  
**问题**: `userId` 直接从 form data 获取，攻击者可以伪造任意用户上传文件  
**修复**: 改为从认证 session 获取 `userId`，忽略客户端传入值 ✅

### 2. `scrape/trigger` — 完全无认证
**文件**: `app/api/scrape/trigger/route.ts`  
**问题**: `_CRON_SECRET` 被导入但从未使用，任何人都可以触发数据抓取和写库  
**修复**: 添加 CRON_SECRET 验证 (Bearer header 或 query param) ✅

### 3. `scrape/mexc` — 完全无认证
**文件**: `app/api/scrape/mexc/route.ts`  
**问题**: 无任何认证检查，任何人都可以触发 MEXC 数据抓取和写库  
**修复**: 添加 CRON_SECRET 验证 ✅

### 4. `admin/scheduler/stats` — 完全无认证
**文件**: `app/api/admin/scheduler/stats/route.ts`  
**问题**: Admin API 无任何认证检查，泄露调度器内部状态  
**修复**: 添加 CRON_SECRET/ADMIN_SECRET 验证 ✅

### 5. `cron/enrich` — 无密钥时允许所有请求
**文件**: `app/api/cron/enrich/route.ts`  
**问题**: `if (!secret) return true` — 如果 CRON_SECRET 未配置，任何人都可调用  
**修复**: 改为仅 development 环境允许，production 拒绝 ✅

---

## 🟡 中等问题 (需关注)

### 6. 部分表缺少 RLS 策略
以下表已创建但未启用 RLS:
- `blocked_users`
- `book_ratings`
- `cron_logs`
- `funding_rates`
- `group_audit_log`, `group_bans`, `group_invites`
- `hot_topics`
- `leaderboard_snapshots`
- `library_items`
- `liquidation_stats`, `liquidations`
- `market_benchmarks`, `market_conditions`
- `open_interest`
- `pipeline_metrics`
- `post_reactions`
- `refresh_jobs`
- `trader_daily_snapshots`, `trader_scores`

**风险**: 这些表通过 service_role key 的 API 路由访问，RLS 不直接影响，但如果任何路径使用 anon key 访问则会暴露数据。  
**建议**: 为所有表启用 RLS 作为纵深防御。

### 7. CORS 过于宽松
- `stream/prices`, `avatar/blockie`, `avatar`, `market/realtime` 使用 `Access-Control-Allow-Origin: *`
- `lib/api/response.ts` 的 `withCors()` 默认 origin 为 `*`

**建议**: 对需要认证的接口限制为具体域名。对公开数据接口(avatar, market data)使用 `*` 可以接受。

---

## 🟢 良好实践 (无问题)

### 8. .env.local 在 .gitignore 中 ✅
`.env*` 和 `.env*.local` 都在 `.gitignore` 中。

### 9. NEXT_PUBLIC_ 环境变量安全 ✅
前端暴露的仅有:
- `NEXT_PUBLIC_APP_URL` — 公开 URL
- `NEXT_PUBLIC_SENTRY_DSN` — Sentry 公钥
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe 公钥
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key (设计上公开)
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase URL
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — WalletConnect ID
- `NEXT_PUBLIC_SNAPSHOT_SPACE_ID` — 公开信息
- `NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS` — 公开合约地址
- `NEXT_PUBLIC_ARENA_SCORE_SCHEMA_UID` — 公开 schema
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — Web Push 公钥

所有 `NEXT_PUBLIC_` 变量都是设计上公开的。✅

### 10. SQL 注入风险 — 低 ✅
所有数据库操作使用 Supabase SDK 的 `.from().select().eq()` 等方法和 `.rpc()` 调用预定义的函数，未发现原始 SQL 拼接。

### 11. XSS 风险 — 低 ✅
`dangerouslySetInnerHTML` 仅用于:
- JSON-LD structured data (来自服务端生成的 JSON)
- Exchange SVG logos (硬编码常量)
- Critical CSS (服务端生成)

无用户输入直接注入 HTML 的情况。

### 12. Cron API CRON_SECRET 验证 ✅ (修复后)
所有 36 个 cron 路由现在都验证 CRON_SECRET。

### 13. Admin API 认证 ✅
Admin 路由使用 `verifyAdmin()` 或 CRON_SECRET/ADMIN_SECRET 验证。

### 14. 无硬编码敏感信息 ✅
未发现 API keys、passwords 等硬编码在代码中。

### 15. Stripe Webhook 安全 ✅
Webhook 使用 `stripe.webhooks.constructEvent()` 验证签名。

---

## 修复 Commit

```
c695f91c security: fix missing auth checks on scrape/trigger, scrape/mexc, admin/scheduler/stats, chat/upload, cron/enrich
4cad4bd3 security: add auth checks to scrape/trigger and admin/scheduler/stats
```
