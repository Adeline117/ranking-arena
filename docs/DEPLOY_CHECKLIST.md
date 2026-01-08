## 上线就绪清单（Ranking Arena）

### 环境变量
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY（仅服务端）
- NEXT_PUBLIC_APP_URL（如 https://www.arenafi.org）
- CRON_SECRET（用于 Vercel Cron 调用鉴权）

### 数据库与存储
1. 在 Supabase SQL Editor 运行：
   - `scripts/fix_user_profiles_complete.sql`
   - `scripts/rls_and_indexes.sql`
2. 在 Storage 创建 `avatars` 桶（公开读）

### 邮件与 OTP
- 在 Supabase Auth 设置开启「Email OTP」，关闭 Magic Link（或仅保留需要）
- 完成自定义域名邮箱的 SPF/DKIM

### Cron 定时任务
- `vercel.json` 已包含示例：每日 09:00 触发 `/api/cron/fetch-traders`
- 在 Vercel 项目设置中配置环境变量 `CRON_SECRET`
- 使用 `curl -X POST -H "x-cron-secret: $CRON_SECRET" https://<domain>/api/cron/fetch-traders` 可手动触发

### 监控与告警（建议）
- 配置 Sentry（前后端）
- Vercel Analytics 打开

### SEO 基础
- `app/robots.ts`、`app/sitemap.ts` 已提供默认实现
- 在 `app/layout.tsx` 更新 `metadataBase` 与站点信息

### 功能回归
- 注册/登录（OTP 和密码）、编辑资料、上传头像
- 关注/取关、发帖
- 首页榜单、交易员详情、分页跳转
- 市场面板仅数字变化，无跳动



