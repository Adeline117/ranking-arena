# Vercel 环境变量配置清单

## 🔴 必需配置（缺失会导致 auto-cleanup 失败）

在 Vercel Dashboard → Project Settings → Environment Variables 中添加：

### Supabase 配置
- `NEXT_PUBLIC_SUPABASE_URL` = `https://iknktzifjdyujdccyhsv.supabase.co`
- `SUPABASE_URL` = `https://iknktzifjdyujdccyhsv.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = (从 .env 文件获取，以 `sb_secret_` 开头)

### Cron 认证
- `CRON_SECRET` = (需要设置一个安全的随机字符串)

## 📝 环境选择
建议配置范围：
- ✅ Production
- ✅ Preview  
- ✅ Development

## ⚠️ 安全警告
- `SUPABASE_SERVICE_ROLE_KEY` 拥有完整数据库权限，务必保密
- `CRON_SECRET` 用于保护 cron 端点，防止未授权调用

## 🔍 验证方法
配置后，访问：
- `https://your-domain.vercel.app/api/cron/cleanup-stuck-logs` (需要 Bearer token)

应该返回 JSON 响应，而不是报错。

---
生成时间: 2026-03-13 06:30 PDT
