# 新交易所数据抓取脚本

为ranking-arena项目添加4个新交易所的数据抓取功能。

## 新增交易所

| 交易所 | 脚本文件 | 目标数量 | 市场类型 | 状态 |
|--------|----------|----------|----------|------|
| **OKX** (扩充) | `import_okx_enhanced.mjs` | 1000+ | Futures + Spot | ✅ 已实现 |
| **Bitfinex** | `import_bitfinex.mjs` | 500+ | Spot + Futures | ✅ 已实现 |
| **Crypto.com** | `import_crypto_com.mjs` | 800+ | Futures | ✅ 已实现 |
| **Pionex** | `import_pionex.mjs` | 600+ | Futures + Spot | ✅ 已实现 |

## 快速开始

### 1. 批量执行 (推荐)
```bash
# 执行所有新交易所脚本
node scripts/import/batch_new_exchanges.mjs

# 指定时间段
node scripts/import/batch_new_exchanges.mjs 30D

# 执行全部时间段
node scripts/import/batch_new_exchanges.mjs ALL
```

### 2. 单独执行

```bash
# OKX 增强版 (扩充到1000+)
node scripts/import/import_okx_enhanced.mjs 30D

# Bitfinex
node scripts/import/import_bitfinex.mjs 7D

# Crypto.com
node scripts/import/import_crypto_com.mjs 90D

# Pionex
node scripts/import/import_pionex.mjs ALL
```

## 数据表结构

### trader_sources 表
```sql
source          VARCHAR  -- 'okx_futures', 'okx_spot', 'bitfinex', 'crypto_com', 'pionex'
source_trader_id VARCHAR  -- 交易所内的trader ID
handle          VARCHAR  -- 用户名/昵称
avatar_url      VARCHAR  -- 头像URL
profile_url     VARCHAR  -- 原始页面链接
is_active       BOOLEAN  -- true
source_kind     VARCHAR  -- 'cex'
market_type     VARCHAR  -- 'futures' 或 'spot'
```

### trader_snapshots 表 (排名数据)
```sql
source          VARCHAR  -- 同上
source_trader_id VARCHAR  -- 同上
season_id       VARCHAR  -- '7D', '30D', '90D'
rank            INTEGER  -- 排名
roi             FLOAT    -- ROI百分比
pnl             FLOAT    -- 盈亏USD
win_rate        FLOAT    -- 胜率百分比
max_drawdown    FLOAT    -- 最大回撤百分比
trade_count     INTEGER  -- 交易次数
followers       INTEGER  -- 跟随者数量
arena_score     FLOAT    -- Arena评分
captured_at     TIMESTAMP -- 抓取时间
```

## 技术特性

### 频率控制
- **全局限制**: 每秒最多2-3个请求
- **随机延迟**: 300ms-2s之间，模拟人类行为
- **重试机制**: 3次重试，指数退避
- **限流处理**: 429状态码自动等待

### 数据质量
- **异常过滤**: ROI > 5000% 的数据会被过滤
- **数据验证**: 检查必要字段完整性
- **去重处理**: 避免重复抓取同一交易员
- **Arena评分**: 自动计算标准化评分

### 错误处理
- **网络重试**: 自动重试失败的请求
- **逐条补救**: 批量失败时逐条重试
- **详细日志**: 记录所有操作和错误信息

## API端点信息

### OKX 增强版
- **Futures**: `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP`
- **Spot**: `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SPOT`
- **特性**: 支持多种排序方式 (pnlRatio, winRatio, copyTraderNum)

### Bitfinex
- **竞赛列表**: `https://api-pub.bitfinex.com/v2/competitions`
- **排行榜**: `https://api-pub.bitfinex.com/v2/competitions/leaderboards/{id}`
- **特性**: 支持多个竞赛类型，实时排行榜

### Crypto.com
- **API**: `https://crypto.com/api/copy-trading/lead-traders`
- **特性**: 支持多种排序 (roi_desc, pnl_desc, followers_desc, winrate_desc)

### Pionex
- **API**: `https://api.pionex.com/api/copy-trading/lead-traders`
- **特性**: POST请求，支持futures和spot两个市场

## 监控和维护

### 检查数据状态
```bash
# 查看各交易所数据量
psql "$DB_URL" -c "
SELECT source, COUNT(*) as trader_count 
FROM trader_sources 
WHERE source IN ('okx_futures', 'okx_spot', 'bitfinex', 'crypto_com', 'pionex')
GROUP BY source 
ORDER BY trader_count DESC;
"

# 查看最新抓取时间
psql "$DB_URL" -c "
SELECT source, season_id, COUNT(*) as snapshots, MAX(captured_at) as latest
FROM trader_snapshots 
WHERE source IN ('okx_futures', 'okx_spot', 'bitfinex', 'crypto_com', 'pionex')
GROUP BY source, season_id 
ORDER BY latest DESC;
"
```

### 性能统计
```bash
# 查看Arena评分分布
psql "$DB_URL" -c "
SELECT source, 
  AVG(arena_score) as avg_score,
  MIN(arena_score) as min_score, 
  MAX(arena_score) as max_score
FROM trader_snapshots 
WHERE source IN ('okx_futures', 'okx_spot', 'bitfinex', 'crypto_com', 'pionex')
  AND season_id = '30D'
GROUP BY source;
"
```

## 故障排除

### 常见问题

1. **API限流 (429错误)**
   ```
   解决: 脚本会自动等待，无需手动干预
   ```

2. **网络连接失败**
   ```bash
   # 检查网络连接
   curl -I https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP
   ```

3. **数据库连接失败**
   ```bash
   # 测试数据库连接
   psql "$DB_URL" -c "SELECT 1;"
   ```

4. **内存不足**
   ```
   解决: 脚本使用流式处理，内存占用较低
   ```

### 调试模式

添加环境变量开启调试:
```bash
DEBUG=1 node scripts/import/import_okx_enhanced.mjs
```

## 定期执行

建议设置cron任务定期更新:

```bash
# 每天更新7D数据
0 2 * * * cd /path/to/ranking-arena && node scripts/import/batch_new_exchanges.mjs 7D

# 每周更新30D数据  
0 3 * * 0 cd /path/to/ranking-arena && node scripts/import/batch_new_exchanges.mjs 30D

# 每月更新90D数据
0 4 1 * * cd /path/to/ranking-arena && node scripts/import/batch_new_exchanges.mjs 90D
```

## 扩展指南

要添加新的交易所，参考现有脚本结构:

1. 创建新的 `import_[交易所].mjs` 文件
2. 实现 `fetchLeaderboard()` 函数
3. 调用 `saveTraders()` 保存数据
4. 添加到 `batch_new_exchanges.mjs` 中

---

**总结**: 这些脚本将为ranking-arena项目新增约3000+交易员数据，覆盖主流CEX交易所的跟单/排行榜功能。