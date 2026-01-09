# 交易所数据自动更新配置

## 📋 当前配置

你的项目已经配置了自动更新机制！

### 1. 自动更新频率

当前配置在 `vercel.json` 中：
```json
{
  "crons": [{ "path": "/api/cron/fetch-traders", "schedule": "0 9 * * *" }]
}
```

**当前设置：每天上午 9:00 UTC（北京时间下午 5:00）自动更新**

### 2. 支持的交易所

自动更新会依次执行以下交易所的数据抓取：
- ✅ Binance (Copy Trading 90天数据)
- ✅ Binance Web3
- ✅ Bybit (90天 ROI)
- ✅ Bitget (90天 ROI)
- ✅ MEXC (90天 ROI)
- ✅ CoinEx (90天 ROI)

### 3. 更新流程

1. Vercel Cron 在指定时间触发 `/api/cron/fetch-traders`
2. API 路由验证 `CRON_SECRET` 环境变量
3. 依次执行每个交易所的数据导入脚本
4. 将执行结果记录到 `cron_logs` 表
5. 返回执行结果（成功/失败）

## 🔧 配置说明

### 修改更新频率

编辑 `vercel.json`，修改 `schedule` 字段：

```json
{
  "crons": [{ 
    "path": "/api/cron/fetch-traders", 
    "schedule": "0 9 * * *"  // 修改这里
  }]
}
```

**Cron 表达式格式：** `分钟 小时 日 月 星期`

常用示例：
- `"0 9 * * *"` - 每天上午 9:00 UTC
- `"0 */6 * * *"` - 每 6 小时
- `"0 0,12 * * *"` - 每天 0:00 和 12:00 UTC
- `"*/30 * * * *"` - 每 30 分钟
- `"0 9 * * 1"` - 每周一上午 9:00 UTC

### 环境变量配置

在 Vercel 项目设置中添加以下环境变量：

1. **CRON_SECRET**（必需）
   - 用于验证 cron 请求的安全性
   - 建议使用随机字符串（如：`openssl rand -hex 32`）
   - 在 Vercel Dashboard → Settings → Environment Variables 中设置

2. **NEXT_PUBLIC_SUPABASE_URL**（必需）
   - Supabase 项目 URL

3. **SUPABASE_SERVICE_ROLE_KEY**（必需）
   - Supabase Service Role Key（有管理员权限）

## 🚀 手动触发更新

### 方法 1：通过 API 调用

```bash
curl -X POST https://your-domain.com/api/cron/fetch-traders \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

### 方法 2：在 Vercel Dashboard

1. 进入 Vercel Dashboard
2. 选择你的项目
3. 进入 "Cron Jobs" 标签
4. 找到 `fetch-traders` 任务
5. 点击 "Run Now"

### 方法 3：本地测试

```bash
# 设置环境变量
export CRON_SECRET=your-secret
export NEXT_PUBLIC_SUPABASE_URL=your-url
export SUPABASE_SERVICE_ROLE_KEY=your-key

# 运行更新脚本
curl -X POST http://localhost:3000/api/cron/fetch-traders \
  -H "x-cron-secret: your-secret"
```

## 📊 查看更新日志

### 在 Supabase Dashboard

1. 进入 Supabase Dashboard
2. 打开 SQL Editor
3. 运行以下查询：

```sql
-- 查看最近的更新记录
SELECT * FROM cron_logs 
WHERE name = 'fetch-traders' 
ORDER BY ran_at DESC 
LIMIT 10;

-- 查看更新结果详情
SELECT 
  ran_at,
  result::json->'results' as results
FROM cron_logs 
WHERE name = 'fetch-traders' 
ORDER BY ran_at DESC 
LIMIT 5;
```

### 在 Vercel Dashboard

1. 进入 Vercel Dashboard
2. 选择项目 → Deployments
3. 查看最新的 deployment logs
4. 搜索 "fetch-traders" 或 "数据抓取"

## ⚠️ 注意事项

1. **超时设置**
   - 每个交易所脚本有 5 分钟超时限制
   - 如果某个交易所超时，会记录错误但继续执行其他交易所

2. **错误处理**
   - 单个交易所失败不会影响其他交易所
   - 所有执行结果都会记录到 `cron_logs` 表

3. **Vercel Cron 限制**
   - 免费版：最多 2 个 cron jobs
   - Pro 版：最多 20 个 cron jobs
   - 执行时间限制：根据计划不同（Hobby: 10秒, Pro: 60秒, Enterprise: 300秒）

4. **数据更新频率建议**
   - 交易所数据通常每天更新 1-2 次即可
   - 过于频繁的更新可能触发 API 限流
   - 建议：每天 1-2 次（如：上午 9:00 和下午 21:00）

## 🔍 故障排查

### Cron Job 没有执行

1. 检查 Vercel Dashboard 中的 Cron Jobs 配置
2. 确认 `CRON_SECRET` 环境变量已设置
3. 查看 Vercel 日志中的错误信息

### 数据更新失败

1. 检查 Supabase 环境变量是否正确
2. 查看 `cron_logs` 表中的错误信息
3. 手动运行单个脚本测试：
   ```bash
   node scripts/import_binance_copy_trading_90d.mjs
   ```

### API 限流

如果遇到 API 限流错误：
- 增加更新间隔时间
- 减少更新频率
- 联系交易所 API 支持申请更高限额

## 📝 更新记录

所有自动更新都会记录到 `cron_logs` 表，包括：
- 执行时间 (`ran_at`)
- 执行结果 (`result`) - JSON 格式，包含每个交易所的成功/失败状态
- 任务名称 (`name`) - "fetch-traders"

