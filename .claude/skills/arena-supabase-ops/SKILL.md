# Arena Supabase Operations

Arena 项目 Supabase 数据库操作规范。

## 数据库连接

```bash
# 直连（本地）
export DATABASE_URL="postgresql://postgres.xxx:password@aws-0-us-west-2.pooler.supabase.com:6543/postgres"

# 通过 Supabase CLI
supabase db remote sql --sql "SELECT 1"
```

## 关键表结构

### trader_sources
- **主键**: `(source, source_trader_id)` 
- **用途**: 存储交易员基础信息
- **注意**: `handle` 可为 NULL（数字 only handle 设为 NULL）

### trader_snapshots
- **主键**: `id` (auto)
- **唯一约束**: `(source, source_trader_id, season_id, captured_at)`
- **关键字段**: `roi`, `pnl`, `win_rate`, `max_drawdown`, `sharpe_ratio`, `sortino_ratio`
- **坑**: `captured_at` 必须每次更新

### trader_daily_snapshots
- **用途**: 存储每日快照用于计算 Sharpe/Sortino
- **唯一约束**: `(platform, trader_key, date)`
- **当前状态**: 26,137 rows（2026-02-23 backfill）

### leaderboard_ranks
- **用途**: 排行榜预计算结果
- **关键字段**: `rank`, `score`, `source`, `period`
- **刷新**: VPS cron 每小时跑 `compute-leaderboard-local.mjs`

## 常见操作

### 1. 检查 null 统计

```sql
SELECT 
  source,
  COUNT(*) as total,
  COUNT(win_rate) as has_wr,
  COUNT(max_drawdown) as has_mdd,
  COUNT(sharpe_ratio) as has_sharpe
FROM trader_snapshots
GROUP BY source
ORDER BY total DESC;
```

### 2. 查找 stale 数据

```sql
SELECT 
  source,
  MAX(captured_at) as last_update,
  NOW() - MAX(captured_at) as age
FROM trader_snapshots
GROUP BY source
HAVING NOW() - MAX(captured_at) > INTERVAL '3 hours'
ORDER BY age DESC;
```

### 3. Upsert 冲突处理

```sql
INSERT INTO trader_snapshots (source, source_trader_id, season_id, roi, captured_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (source, source_trader_id, season_id, captured_at) 
DO UPDATE SET 
  roi = EXCLUDED.roi,
  captured_at = NOW();
```

**Supabase JS:**
```javascript
const { error } = await supabase
  .from('trader_snapshots')
  .upsert(rows, { 
    onConflict: 'source,source_trader_id,season_id,captured_at' 
  })
```

### 4. 批量更新（分批避免超时）

```javascript
const BATCH = 50
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(batch, { onConflict: '...' })
  if (error) console.error(`Batch ${i}:`, error.message)
  await sleep(100)
}
```

## RLS 策略

Arena 使用 Supabase RLS（Row Level Security）。关键策略：

- `anon` 角色：可以 SELECT 公开表
- `authenticated`：可以读写自己的数据
- `service_role`：绕过 RLS（仅服务端）

**检查 RLS:**
```sql
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public';
```

## 性能优化

### 索引

```sql
-- trader_snapshots 常用查询索引
CREATE INDEX IF NOT EXISTS idx_snapshots_source_season 
ON trader_snapshots(source, season_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_captured 
ON trader_snapshots(captured_at DESC);

-- leaderboard_ranks
CREATE INDEX IF NOT EXISTS idx_ranks_source_period_rank 
ON leaderboard_ranks(source, period, rank);
```

### 分页

```javascript
// 使用 range 而不是 offset/limit
const { data } = await supabase
  .from('trader_snapshots')
  .select('*')
  .range(0, 99)  // 第一页 100 条
```

## 迁移记录

| 日期 | 内容 | Commit |
|------|------|--------|
| 2026-02-22 | 添加 monitoring RPC | - |
| 2026-02-22 | season_id 索引 | - |

## 更新日志

- 2026-02-23: 创建 skill，记录表结构、常见操作、性能优化
