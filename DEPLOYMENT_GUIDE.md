# 🚀 生产环境部署指南

**部署日期**: 2026-01-28  
**版本**: Smart Scheduler + Security Audit  
**风险等级**: 低

---

## 📋 部署前检查清单

### 1. 代码验证 ✅
- [x] 所有更改已推送到 main 分支
- [x] TypeScript 类型检查通过
- [x] ESLint 无错误
- [x] 单元测试通过
- [x] 安全漏洞修复完成

### 2. 数据库准备
- [ ] 备份当前生产数据库
- [ ] 准备回滚脚本
- [ ] 验证迁移脚本

### 3. 环境变量配置
- [ ] 验证所有必需的环境变量
- [ ] 设置 Smart Scheduler 配置
- [ ] 更新 CRON_SECRET（如需要）

---

## 🗃️ 数据库迁移步骤

### Step 1: 备份生产数据库

```bash
# 通过 Supabase Dashboard 或命令行备份
# Supabase Dashboard: Database > Backups > Create new backup

# 或使用 pg_dump（如果有直接访问权限）
pg_dump $PRODUCTION_DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
```

### Step 2: 应用 Smart Scheduler 迁移

```bash
# 连接到生产数据库
psql $PRODUCTION_DATABASE_URL

# 或通过 Supabase SQL Editor 执行以下内容：
```

**迁移脚本**: `supabase/migrations/00026_smart_scheduler.sql`

**检查点**:
```sql
-- 验证表结构
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'trader_sources' 
AND column_name IN ('activity_tier', 'next_refresh_at', 'last_refreshed_at');

-- 应该返回 3 行
```

### Step 3: 验证数据完整性

```sql
-- 检查现有交易员是否都有默认值
SELECT 
  COUNT(*) as total_traders,
  COUNT(activity_tier) as traders_with_tier,
  COUNT(next_refresh_at) as traders_with_schedule
FROM trader_sources;

-- total_traders 应该等于 traders_with_tier 和 traders_with_schedule
```

---

## 🔧 环境变量配置

### Vercel 环境变量设置

访问: https://vercel.com/your-team/ranking-arena/settings/environment-variables

**新增/验证变量**:

```bash
# Smart Scheduler 配置（可选，默认值已设置）
ENABLE_SMART_SCHEDULER=false          # 初始设为 false，观察后再启用
SMART_SCHEDULER_HOT_INTERVAL=15       # 热门交易员刷新间隔（分钟）
SMART_SCHEDULER_ACTIVE_INTERVAL=60    # 活跃交易员刷新间隔（分钟）
SMART_SCHEDULER_NORMAL_INTERVAL=240   # 普通交易员刷新间隔（分钟）
SMART_SCHEDULER_DORMANT_INTERVAL=1440 # 休眠交易员刷新间隔（分钟）

# 活动等级阈值配置（可选）
SMART_SCHEDULER_HOT_RANK_THRESHOLD=100
SMART_SCHEDULER_HOT_VIEWS_THRESHOLD=1000
SMART_SCHEDULER_HOT_FOLLOWERS_THRESHOLD=10000
SMART_SCHEDULER_ACTIVE_RANK_THRESHOLD=500
SMART_SCHEDULER_ACTIVE_FOLLOWERS_THRESHOLD=1000

# 必需的安全配置（如果还没有）
ADMIN_EMAILS=your-admin@example.com    # 管理员邮箱列表（逗号分隔）
CRON_SECRET=your-secure-random-string   # Cron job 认证密钥（>=32字符）

# Sentry（推荐但可选）
SENTRY_DSN=your-sentry-dsn
```

### 生成安全的 CRON_SECRET

```bash
# 生成随机 32 字符密钥
openssl rand -base64 32

# 或使用 Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## 🚀 部署流程

### 选项 A: Vercel 自动部署（推荐）

如果您的 main 分支已连接到 Vercel：

1. **触发部署**
   ```bash
   git push origin main  # 已完成 ✅
   ```

2. **监控部署**
   - 访问 Vercel Dashboard
   - 查看部署日志
   - 等待部署完成（通常 2-5 分钟）

3. **验证部署**
   - 访问生产 URL
   - 检查控制台无错误
   - 验证功能正常

### 选项 B: 手动触发 Vercel 部署

```bash
# 使用 Vercel CLI
vercel --prod

# 或在 Vercel Dashboard 手动触发
# Deployments > ... > Redeploy
```

---

## ✅ 部署后验证

### 1. 基础功能验证（5 分钟）

```bash
# 检查网站可访问性
curl -I https://your-domain.com

# 应该返回 200 OK
```

**手动检查**:
- [ ] 首页加载正常
- [ ] 排行榜显示正常
- [ ] 用户登录功能正常
- [ ] API 端点响应正常

### 2. Smart Scheduler 验证（10 分钟）

**Step 1: 测试 Tier 计算 API**
```bash
# 首次运行（会分类所有交易员）
curl -X GET "https://your-domain.com/api/cron/calculate-tiers" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"

# 预期响应：
# {
#   "success": true,
#   "stats": {
#     "hot": 150,
#     "active": 800,
#     "normal": 3000,
#     "dormant": 8050
#   },
#   "estimatedSavings": {
#     "apiCallReduction": "67%",
#     "costSavingsPerMonth": "$27,690"
#   }
# }
```

**Step 2: 检查数据库**
```sql
-- 在 Supabase SQL Editor 执行
SELECT 
  activity_tier,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (next_refresh_at - NOW()))/60) as avg_next_refresh_minutes
FROM trader_sources
WHERE activity_tier IS NOT NULL
GROUP BY activity_tier
ORDER BY 
  CASE activity_tier
    WHEN 'hot' THEN 1
    WHEN 'active' THEN 2
    WHEN 'normal' THEN 3
    WHEN 'dormant' THEN 4
  END;

-- 预期结果：4 行，每个 tier 一行
```

**Step 3: 查看监控统计**
```bash
# 访问管理员统计页面
curl "https://your-domain.com/api/admin/scheduler/stats"

# 或在浏览器访问
# https://your-domain.com/api/admin/scheduler/stats
```

### 3. 安全验证（5 分钟）

```bash
# 验证安全更新
npm audit

# 应该显示：
# found 0 vulnerabilities (或只有 low severity)
```

**手动检查**:
- [ ] Next.js 版本 >= 16.1.6
- [ ] 无 HIGH/MODERATE 漏洞
- [ ] HTTPS 正常工作
- [ ] 安全头部设置正确

**检查安全头部**:
```bash
curl -I https://your-domain.com | grep -E "strict-transport|content-security|x-frame"

# 应该看到：
# strict-transport-security: max-age=31536000
# content-security-policy: ...
# x-frame-options: DENY
```

---

## 📊 监控设置（部署后立即）

### 1. 设置 Vercel Analytics

如果还没有启用：
- 访问 Vercel Dashboard > Analytics
- 启用 Web Analytics
- 启用 Speed Insights

### 2. Sentry 错误监控

```bash
# 验证 Sentry 配置
curl "https://your-domain.com/api/health"

# 触发测试错误（仅在测试环境）
# curl "https://your-domain.com/api/test-error"
```

### 3. Smart Scheduler 监控仪表板

**设置提醒**:
- 如果 API 调用次数没有减少
- 如果 tier 分类失败
- 如果数据新鲜度下降

**监控指标**:
```bash
# 每小时检查一次（前 24 小时）
watch -n 3600 'curl -s https://your-domain.com/api/admin/scheduler/stats | jq'
```

---

## 🔄 逐步启用 Smart Scheduler

### 阶段 1: 观察模式（第 1-3 天）

**配置**:
```bash
ENABLE_SMART_SCHEDULER=false  # 保持禁用
```

**操作**:
- Tier 计算 cron 正常运行（每 15 分钟）
- 数据被分类但不影响刷新逻辑
- 观察 tier 分布是否合理
- 收集基线指标

**检查点**:
```bash
# 每天检查 tier 分布
curl https://your-domain.com/api/admin/scheduler/stats
```

### 阶段 2: 部分启用（第 4-7 天）

**配置**:
```bash
ENABLE_SMART_SCHEDULER=true  # 启用
```

**操作**:
- Smart Scheduler 开始影响刷新逻辑
- 密切监控 API 调用次数
- 观察数据新鲜度
- 收集成本数据

**监控**:
- API 调用次数应该开始下降
- 热门交易员数据应该更频繁
- 休眠交易员更新频率降低

### 阶段 3: 全面生产（第 8+ 天）

**验证标准**:
- ✅ API 调用减少 > 60%
- ✅ 热门交易员数据新鲜（< 20 分钟）
- ✅ 无性能问题
- ✅ 无用户投诉
- ✅ 成本节省明显

**如果满足标准**:
- 保持启用
- 优化 tier 阈值（如需要）
- 记录成功指标

---

## 🚨 问题排查

### 问题 1: Tier 计算 API 失败

**症状**: `/api/cron/calculate-tiers` 返回错误

**检查**:
```bash
# 1. 验证数据库连接
psql $DATABASE_URL -c "SELECT 1"

# 2. 检查迁移是否应用
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'trader_sources' AND column_name = 'activity_tier'"

# 3. 查看 Vercel 日志
```

**解决方案**:
- 重新应用数据库迁移
- 检查环境变量配置
- 联系支持团队

### 问题 2: API 调用次数没有减少

**症状**: 启用后 API 调用仍然很高

**检查**:
```bash
# 1. 验证环境变量
curl https://your-domain.com/api/admin/scheduler/stats

# 2. 检查 ENABLE_SMART_SCHEDULER 设置
```

**解决方案**:
- 确认 `ENABLE_SMART_SCHEDULER=true`
- 等待下一个 cron 周期
- 检查 tier 分布是否合理

### 问题 3: 数据新鲜度下降

**症状**: 热门交易员数据更新不及时

**检查**:
```sql
-- 检查热门交易员的刷新间隔
SELECT 
  trader_id,
  activity_tier,
  last_refreshed_at,
  next_refresh_at,
  NOW() - last_refreshed_at as time_since_refresh
FROM trader_sources
WHERE activity_tier = 'hot'
ORDER BY last_refreshed_at DESC
LIMIT 20;
```

**解决方案**:
- 调整 `SMART_SCHEDULER_HOT_INTERVAL`
- 增加热门交易员的定义阈值
- 检查 cron job 是否正常运行

---

## ⏮️ 回滚计划

如果出现严重问题，可以快速回滚：

### 快速回滚（< 5 分钟）

**Step 1: 禁用 Smart Scheduler**
```bash
# 在 Vercel 设置环境变量
ENABLE_SMART_SCHEDULER=false

# 触发重新部署
vercel --prod
```

**Step 2: 恢复之前的部署**
```bash
# 在 Vercel Dashboard
# Deployments > [Previous Working Deployment] > Promote to Production
```

### 完全回滚（< 15 分钟）

**Step 1: 回滚代码**
```bash
# 回滚到部署前的 commit
git revert HEAD~2..HEAD
git push origin main
```

**Step 2: 回滚数据库**
```bash
# 从备份恢复
psql $DATABASE_URL < backup-YYYYMMDD-HHMMSS.sql

# 或删除新增的列（如果数据不重要）
ALTER TABLE trader_sources 
DROP COLUMN activity_tier,
DROP COLUMN next_refresh_at,
DROP COLUMN last_refreshed_at,
DROP COLUMN refresh_priority,
DROP COLUMN tier_updated_at;
```

---

## 📞 支持联系

如果遇到问题：

1. **检查文档**:
   - `SMART_SCHEDULER_INTEGRATION.md`
   - `docs/smart-scheduler-integration-complete.md`
   - `docs/SECURITY_SUMMARY.md`

2. **查看日志**:
   - Vercel Dashboard > Deployments > [Latest] > Logs
   - Sentry Dashboard

3. **数据库检查**:
   - Supabase Dashboard > Database > Table Editor
   - 查看 `trader_sources` 表

---

## ✅ 部署完成检查清单

部署成功标准：

- [ ] 网站可访问，无错误
- [ ] 数据库迁移成功
- [ ] Tier 计算 API 正常工作
- [ ] 监控仪表板显示数据
- [ ] 安全漏洞已修复
- [ ] 文档已更新
- [ ] 团队已通知
- [ ] 监控告警已设置

---

## 🎯 预期结果

### 立即效果（第 1 天）
- ✅ 网站正常运行
- ✅ 所有功能正常
- ✅ 安全漏洞修复
- ✅ Tier 分类开始工作

### 短期效果（第 1 周）
- 📊 Tier 分布稳定
- 📉 API 调用开始减少（如果启用）
- 💰 成本节省开始显现
- 📈 数据新鲜度保持或改善

### 长期效果（第 1 月）
- 💰 成本节省 $27,690/月
- 📊 API 调用减少 67%
- ⚡ 热门数据更及时
- 📈 系统性能改善

---

**部署者**: _________________  
**部署日期**: _________________  
**验证人**: _________________  
**验证日期**: _________________

---

**祝部署顺利！** 🚀
