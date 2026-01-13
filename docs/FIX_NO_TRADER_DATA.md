# 修复"看不到交易者数据"问题

## 问题诊断

从控制台日志可以看到：
- ✅ `timestamps` 有值（binance 和 binance_web3 都有时间戳）
- ❌ `snapshotCounts` 都是 0（所有数据源）
- ❌ `handleMapSizes` 都是 0
- ❌ `allTradersDataLength: 0`

**问题原因**：虽然数据库中有时间戳记录，但查询快照数据时返回空数组。

## 可能的原因

### 1. 查询字段不存在（最可能）

查询时使用了不存在的字段，导致查询失败。

**解决方案**：已简化查询字段，只查询基本字段：
- `source_trader_id`
- `rank`
- `roi`
- `followers`
- `pnl`
- `win_rate`

### 2. 时间戳格式不匹配

`captured_at` 字段的值可能与查询条件不完全匹配（时区、精度等）。

**检查方法**：
```sql
-- 在 Supabase SQL Editor 中运行
SELECT 
  source,
  captured_at,
  COUNT(*) as count
FROM trader_snapshots
WHERE source = 'binance_web3'
GROUP BY source, captured_at
ORDER BY captured_at DESC
LIMIT 10;
```

### 3. 数据确实不存在

虽然有时间戳记录，但该时间戳对应的快照数据可能已被删除或不存在。

## 解决步骤

### 步骤 1: 刷新页面查看新日志

刷新浏览器页面，查看控制台的新日志：
- `[trader-snapshots] ✅ ${source} 最新时间戳: ...`
- `[trader-snapshots] ✅ ${source} 查询成功: X 条记录`
- `[trader-snapshots] 🔍 ${source} 调试: 该数据源的所有 captured_at 值`

### 步骤 2: 检查数据库

在 Supabase Dashboard 的 SQL Editor 中运行：

```sql
-- 检查 binance_web3 的数据
SELECT 
  source,
  captured_at,
  COUNT(*) as count,
  MIN(captured_at) as earliest,
  MAX(captured_at) as latest
FROM trader_snapshots
WHERE source = 'binance_web3'
GROUP BY source, captured_at
ORDER BY captured_at DESC
LIMIT 5;

-- 检查是否有基本字段的数据
SELECT 
  source_trader_id,
  rank,
  roi,
  captured_at
FROM trader_snapshots
WHERE source = 'binance_web3'
ORDER BY rank
LIMIT 5;
```

### 步骤 3: 如果数据库没有数据

需要运行数据导入脚本：

```bash
# 导入 Binance Web3 数据（通常数据最多）
node scripts/fetch_binance_web3_all_pages.mjs

# 导入其他数据源
node scripts/import_binance_copy_trading_90d.mjs
node scripts/import_bybit_90d_roi.mjs
node scripts/import_bitget_90d_roi.mjs
node scripts/import_mexc_90d_roi.mjs
```

### 步骤 4: 检查 RLS 策略

如果数据存在但查询返回空，可能是 RLS 策略问题：

```sql
-- 检查 trader_snapshots 表的 RLS 策略
SELECT * FROM pg_policies WHERE tablename = 'trader_snapshots';

-- 如果 RLS 阻止了查询，需要调整策略
-- 通常应该允许所有人读取：
ALTER TABLE trader_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trader_snapshots are viewable by everyone" ON trader_snapshots;
CREATE POLICY "trader_snapshots are viewable by everyone"
  ON trader_snapshots FOR SELECT
  USING (true);
```

## 快速修复

如果确认数据库有数据但查询返回空，可以尝试：

1. **简化查询**（已实现）：
   - 只查询基本字段，避免字段不存在导致查询失败

2. **检查时间戳匹配**：
   - 使用调试日志查看实际的时间戳值
   - 确认查询条件中的时间戳格式正确

3. **直接查询测试**：
   ```sql
   -- 测试查询
   SELECT source_trader_id, rank, roi, captured_at
   FROM trader_snapshots
   WHERE source = 'binance_web3'
   AND captured_at = '2026-01-06T02:00:18.535+00:00'
   LIMIT 5;
   ```

## 下一步

1. 刷新页面，查看新的调试日志
2. 在 Supabase 中运行 SQL 查询检查数据
3. 如果数据不存在，运行导入脚本
4. 如果数据存在但查询失败，检查 RLS 策略

请告诉我新的控制台日志显示了什么信息！

