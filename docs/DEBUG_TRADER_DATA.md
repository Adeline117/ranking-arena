# 交易者数据调试指南

如果看不到交易者数据，请按以下步骤排查：

## 1. 检查数据库是否有数据

在 Supabase Dashboard 的 SQL Editor 中运行以下查询：

```sql
-- 检查各数据源的快照数量
SELECT 
  source,
  COUNT(*) as count,
  MAX(captured_at) as latest_capture
FROM trader_snapshots
GROUP BY source
ORDER BY source;
```

**预期结果**：应该看到各个数据源（binance, binance_web3, bybit 等）都有数据。

**如果没有数据**：
- 需要运行数据导入脚本
- 或等待定时任务自动导入

## 2. 检查最新快照时间

```sql
-- 检查每个数据源的最新快照
SELECT 
  source,
  captured_at,
  COUNT(*) as trader_count
FROM trader_snapshots
WHERE captured_at = (
  SELECT MAX(captured_at) 
  FROM trader_snapshots t2 
  WHERE t2.source = trader_snapshots.source
)
GROUP BY source, captured_at
ORDER BY source;
```

**预期结果**：每个数据源都应该有最新的 `captured_at` 时间戳。

## 3. 检查 trader_sources 表

```sql
-- 检查 handle 数据
SELECT 
  source,
  COUNT(*) as count
FROM trader_sources
GROUP BY source
ORDER BY source;
```

**预期结果**：应该有 handle 数据，用于显示交易者名称。

## 4. 检查浏览器控制台

打开浏览器开发者工具（F12），查看 Console 标签：

1. **查找日志**：
   - `[trader-loader]` - 数据加载日志
   - `[trader-snapshots]` - 快照查询日志

2. **检查错误**：
   - 红色错误信息
   - 网络请求失败

3. **查看数据统计**：
   ```
   [trader-loader] 📊 binance: handleMap=X 条, snapshots=Y 条
   [trader-loader] ⚡ 加载耗时: Xms
   [trader-loader] 📈 加载了 X 个交易员
   ```

## 5. 检查网络请求

在浏览器开发者工具的 Network 标签中：

1. 刷新页面
2. 查找对 Supabase 的请求
3. 检查请求是否成功（状态码 200）
4. 查看响应数据

## 6. 常见问题

### 问题 1: 数据库中没有数据

**解决方案**：
1. 手动运行数据导入脚本：
   ```bash
   node scripts/import_binance_copy_trading_90d.mjs
   node scripts/fetch_binance_web3_all_pages.mjs
   # ... 其他脚本
   ```

2. 或触发定时任务：
   ```bash
   curl -X POST http://localhost:3000/api/cron/fetch-traders \
     -H "x-cron-secret: your-secret"
   ```

### 问题 2: 数据源没有最新时间戳

**原因**：某个数据源可能没有数据或数据过期

**解决方案**：
- 检查该数据源的导入脚本是否正常运行
- 检查 `captured_at` 字段是否有值

### 问题 3: 控制台显示错误但数据为空

**可能原因**：
- RLS（Row Level Security）策略阻止了查询
- 数据库连接问题
- 查询字段不存在

**解决方案**：
1. 检查 Supabase RLS 策略
2. 检查环境变量 `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. 检查数据库表结构是否完整

### 问题 4: 数据加载但页面不显示

**可能原因**：
- 前端组件渲染问题
- 数据格式不匹配

**解决方案**：
1. 检查 `RankingTable` 组件是否正确接收数据
2. 检查 `traders` 数组是否为空
3. 查看浏览器控制台是否有 React 错误

## 7. 快速测试

在浏览器控制台运行：

```javascript
// 检查 Supabase 连接
const { createClient } = await import('@supabase/supabase-js')
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

// 测试查询
const { data, error } = await supabase
  .from('trader_snapshots')
  .select('source, source_trader_id, roi')
  .eq('source', 'binance_web3')
  .limit(5)

console.log('数据:', data)
console.log('错误:', error)
```

## 8. 强制刷新数据

如果数据已更新但页面仍显示旧数据：

1. 硬刷新页面：`Ctrl+Shift+R` (Windows) 或 `Cmd+Shift+R` (Mac)
2. 清除浏览器缓存
3. 检查是否有缓存策略影响

## 9. 检查数据导入状态

访问 `/admin` 页面（如果已实现）查看数据导入状态。

或直接查询：

```sql
-- 查看最近的数据导入时间
SELECT 
  source,
  MAX(captured_at) as last_import,
  COUNT(*) as total_records
FROM trader_snapshots
GROUP BY source
ORDER BY last_import DESC;
```

## 10. 联系支持

如果以上步骤都无法解决问题，请提供：
1. 浏览器控制台的完整错误信息
2. 数据库查询结果
3. 网络请求的响应数据

