# Arena 成本监控报告
**版本：** 1.0  
**日期：** 2026-03-13  
**监控周期：** 实时 + 每周审查  

---

## 📊 当前成本预估

### 1. Vercel (Web Hosting)
**计划：** Hobby（免费）或 Pro（$20/月）

**使用量（需确认Dashboard）：**
- **Serverless调用：** ? / 100k（Hobby限额）
- **Edge Middleware：** ? / 1M（Hobby限额）
- **Bandwidth：** ? / 100GB（Hobby限额）
- **Build时间：** ? / 6000分钟（Hobby限额）

**Cron任务：** 43个任务
**估算调用量/月：**
```
假设平均每个cron每小时运行1次：
43 crons × 24 hours × 30 days = 30,960 调用/月

假设部分cron每15分钟运行：
高频cron: 10个 × 96次/天 × 30天 = 28,800
低频cron: 33个 × 24次/天 × 30天 = 23,760
总计: ~52,560 调用/月
```

**风险评估：** 🟡 **中风险**  
- 52k调用接近Hobby限额100k的50%
- 需升级到Pro计划（$20/月）如果流量增长

**行动项：**
1. ✅ 检查Vercel Dashboard实际用量
2. 设置告警：80% Hobby限额（80k调用）
3. 考虑优化cron频率（减少不必要的高频调用）

---

### 2. Supabase (Database)
**计划：** Free或 Pro（$25/月）

**使用量（需确认Dashboard）：**
- **数据库大小：** ? / 500MB（Free限额）
- **带宽：** ? / 2GB（Free限额）
- **存储：** ? / 1GB（Free限额）

**关键表数据量：**
```sql
-- trader_snapshots: 2.8M 行（估计300-500MB）
-- trader_snapshots_v2: ? 行
-- trader_daily_snapshots: ? 行
-- 其他表：? 行
```

**风险评估：** 🟡 **中风险**  
- trader_snapshots可能已占用大部分Free限额
- 每日增长速度未知
- 需监控是否需要升级到Pro

**行动项：**
1. ✅ 检查Supabase Dashboard数据库大小
2. 计算每日增长速度
3. 如果>400MB → 立即升级Pro（$25/月）
4. 考虑归档老数据到R2（>90天的snapshots）

---

### 3. Upstash Redis (Caching)
**计划：** Free或 Pay-as-you-go

**使用量（需确认Dashboard）：**
- **每日请求：** ? / 10k（Free限额）
- **存储：** ? / 256MB（Free限额）
- **带宽：** ? / 200MB/天（Free限额）

**使用场景：**
- Cron任务状态缓存
- API响应缓存
- 速率限制计数器

**风险评估：** 🟢 **低风险**  
- Redis主要用于临时缓存，存储需求小
- 除非流量暴增，否则Free计划足够

**行动项：**
1. ✅ 检查Upstash Dashboard每日请求量
2. 如果接近10k → 考虑减少缓存TTL或升级

---

### 4. Cloudflare R2 (Backups)
**计划：** Free（10GB存储，无egress费用）

**使用量（需确认Dashboard）：**
- **存储：** ? / 10GB（Free限额）
- **Class A请求：** ? / 1M/月（Free）
- **Class B请求：** ? / 10M/月（Free）

**每日备份大小估算：**
```
每日trader表备份：~100-200MB（压缩后）
每周完整备份：~500MB-1GB（压缩后）

每月总存储：
- 每日备份 × 30天 = 6GB
- 每周备份 × 4周 = 4GB
- 总计：~10GB（接近Free限额）
```

**风险评估：** 🟡 **中风险**  
- 每月备份总量接近10GB限额
- 需实施备份轮转策略（删除>30天的每日备份）

**行动项：**
1. ✅ 检查R2 Dashboard存储用量
2. 实施自动清理脚本（删除>30天的每日备份）
3. 保留每周备份90天
4. 如果超10GB → 升级到付费（$0.015/GB/月，很便宜）

---

### 5. 其他服务

#### Sentry (错误监控)
**计划：** Developer（免费）或 Team（$26/月）  
**限额：** 5k errors/月（免费）  
**风险：** 🟢 低

#### Stripe (支付)
**费用：** 2.9% + $0.30/笔（按交易收费）  
**风险：** 🟢 低（只有付费用户才产生费用）

#### API服务（免费）
- ✅ Dune Analytics（免费额度）
- ✅ Etherscan（免费额度）
- ✅ Alchemy（免费额度）
- ✅ Solscan（免费）

---

## 💰 总成本估算

### 当前免费方案
```
Vercel Hobby:     $0/月
Supabase Free:    $0/月
Upstash Free:     $0/月
Cloudflare R2:    $0/月
---
总计:             $0/月
```

### 升级后成本（如果需要）
```
Vercel Pro:       $20/月
Supabase Pro:     $25/月
Upstash PAYG:     ~$5/月
Cloudflare R2:    ~$1/月
Sentry Team:      $26/月（可选）
---
总计:             $51-77/月
```

---

## 🚨 成本告警阈值

设置以下告警规则：

### Vercel
- **警告（80%）：** 80k Serverless调用/月
- **紧急（95%）：** 95k Serverless调用/月
- **行动：** 优化cron频率或升级Pro

### Supabase
- **警告（80%）：** 400MB数据库大小
- **紧急（95%）：** 475MB数据库大小
- **行动：** 归档老数据或升级Pro

### Upstash
- **警告（80%）：** 8k请求/天
- **紧急（95%）：** 9.5k请求/天
- **行动：** 减少缓存或升级PAYG

### Cloudflare R2
- **警告（80%）：** 8GB存储
- **紧急（95%）：** 9.5GB存储
- **行动：** 清理老备份或升级（很便宜）

---

## 📈 成本监控脚本

创建自动化监控脚本：

### 1. Vercel用量检查
```bash
#!/bin/bash
# scripts/monitoring/check-vercel-usage.sh

echo "📊 Checking Vercel usage..."

# 需要Vercel API token
VERCEL_TOKEN="your_token_here"

curl -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v2/teams/{teamId}/usage" \
  | jq '.usage'
```

### 2. Supabase用量检查
```typescript
// scripts/monitoring/check-supabase-usage.ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function checkDatabaseSize() {
  const { data, error } = await supabase.rpc('pg_database_size', {
    database_name: 'postgres'
  })
  
  const sizeGB = data / (1024 ** 3)
  console.log(`Database size: ${sizeGB.toFixed(2)} GB`)
  
  if (sizeGB > 0.4) {
    console.warn('⚠️ Approaching Free tier limit (500MB)!')
  }
}

checkDatabaseSize()
```

### 3. 每周成本报告
```typescript
// scripts/monitoring/weekly-cost-report.ts
async function generateCostReport() {
  const report = {
    date: new Date().toISOString(),
    vercel: await checkVercelUsage(),
    supabase: await checkSupabaseUsage(),
    upstash: await checkUpstashUsage(),
    r2: await checkR2Usage(),
  }
  
  // 发送到Telegram
  await sendTelegramMessage(
    `📊 Weekly Cost Report\n\n${JSON.stringify(report, null, 2)}`
  )
}
```

---

## 🎯 优化建议

### 1. Cron任务优化
**当前：** 43个任务，部分高频运行

**优化方案：**
- 合并相似任务（减少冷启动）
- 降低非关键任务频率（如每小时 → 每4小时）
- 使用Vercel Edge Config缓存配置（减少数据库调用）

**预期节省：** 30-40%调用量

---

### 2. 数据库优化
**当前：** trader_snapshots 2.8M行

**优化方案：**
- 归档>90天的数据到R2（JSON格式）
- 删除重复的snapshots（去重）
- 压缩老数据（JSON → JSONB）

**预期节省：** 40-50%存储空间

---

### 3. 缓存优化
**当前：** Upstash用于短期缓存

**优化方案：**
- 增加热点数据缓存（leaderboard, trader profiles）
- 使用Vercel Edge Cache（CDN缓存）
- 延长非实时数据TTL

**预期节省：** 减少50%数据库调用

---

## 📅 监控时间表

### 每日检查（自动化）
- [ ] Vercel调用量（通过API）
- [ ] R2存储用量（通过API）
- [ ] 错误率（Sentry）

### 每周检查（手动）
- [ ] Supabase数据库大小
- [ ] Upstash请求量
- [ ] 总成本趋势
- [ ] 发送周报到Telegram

### 每月检查（手动）
- [ ] 审查所有Dashboard
- [ ] 更新成本预测
- [ ] 决定是否升级计划
- [ ] 优化低效查询

---

## 🔗 Dashboard链接

快速访问：
- **Vercel:** https://vercel.com/dashboard/usage
- **Supabase:** https://supabase.com/dashboard/project/iknktzifjdyujdccyhsv/settings/database
- **Upstash:** https://console.upstash.com/redis
- **Cloudflare R2:** https://dash.cloudflare.com/r2/overview
- **Sentry:** https://arca-h9.sentry.io/

---

## 行动项汇总

| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🔴 P0 | 检查所有服务Dashboard用量 | Adeline | 2026-03-14 |
| 🔴 P0 | 设置成本告警（80%阈值） | Adeline | 2026-03-15 |
| 🟡 P1 | 创建自动化监控脚本 | 小昭 | 2026-03-16 |
| 🟡 P1 | 优化高频cron任务 | Adeline | 2026-03-20 |
| 🟢 P2 | 归档老数据到R2 | Adeline | 2026-03-30 |
| 🟢 P2 | 实施每周成本报告 | Adeline | 2026-03-30 |

---

**文档版本历史：**
- v1.0 (2026-03-13): 初始版本
- v1.1 (待定): 添加实际用量数据

**下次审核日期：** 2026-03-20（首次全面审查）
