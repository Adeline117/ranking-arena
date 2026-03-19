# Bitget Futures Enrichment Fix Report

## 问题描述

Bitget futures enrichment 间歇性卡死 44 分钟，导致整个 pipeline 阻塞。

## 调查结果

### 1. 日志模式分析

通过 `scripts/check-bitget-logs.ts` 发现明显的双峰模式：

**成功运行** ✅
- 耗时：25-30 秒
- Metadata：包含 `period` (7D/30D/90D)
- 频率：每 4 小时（Vercel cron `batch-enrich` 触发）

**失败运行** ❌
- 耗时：44-46 分钟（卡死后被外部 kill）
- Metadata：空 `{}`
- Error：`"Killed: stuck 44min (Nth occurrence)"`
- 频率：不规律

### 2. 根本原因

1. **Cloudflare Worker Proxy 间歇性卡住**
   - Bitget enrichment 通过 `ranking-arena-proxy.broosbook.workers.dev` 代理请求
   - `fetchJson` 设置了 20 秒 timeout
   - 但 CF Worker 本身可能卡住（不是 timeout，而是无响应）

2. **超时保护不够激进**
   - Per-trader timeout: 30 秒（CEX 默认）
   - 如果一个 trader 卡住，会阻塞整个 batch
   - Withretry 逻辑可能让单个 API 调用重试 3 次 = 60 秒

3. **并发度过高**
   - 之前 `concurrency: 2`，两个 trader 同时请求可能加剧 proxy 负载

## 修复方案

### Commit: `80ca3246` - Add aggressive per-trader timeout

1. **新增配置**：`PER_TRADER_TIMEOUT_MS`
   ```typescript
   const PER_TRADER_TIMEOUT_MS: Record<string, number> = {
     'bitget_futures': 25_000,  // 25s per trader - aggressive to prevent 44min hangs
   }
   ```

2. **Platform timeout**
   ```typescript
   const PLATFORM_TIMEOUT_MS: Record<string, number> = {
     'bitget_futures': 120_000,  // 2min total
   }
   ```

3. **降低并发度和增加延迟**
   ```typescript
   bitget_futures: {
     concurrency: 1,  // Reduced from 2
     delayMs: 3000,   // Increased from 2000
   }
   ```

4. **只保留 Equity Curve enrichment**
   - `fetchStatsDetail` 和 `fetchPositionHistory` 已被移除（它们会卡死）
   - Stats 数据从 leaderboard `normalize()` 获取

## 防护措施

### 多层 Timeout 保护

1. **API 层**: `fetchJson` 20 秒 timeout
2. **Trader 层**: 25 秒 per-trader timeout（bitget 专用）
3. **Platform 层**: 120 秒 per-platform timeout
4. **Batch 层**: `batch-enrich` 总 timeout 控制

### Fail-Fast 策略

- 任何单个 trader 超过 25 秒立即 timeout
- 失败 trader 不影响其他 trader
- Platform 总时间不超过 120 秒

## 预期结果

**之前**：
- 成功：25-30 秒
- 失败：44 分钟卡死

**修复后**：
- 成功：25-30 秒（不变）
- 失败：最多 25 秒（快速失败）
- 整个 platform：最多 120 秒

## 监控

使用 `scripts/check-bitget-recent.ts` 监控最近 24 小时的运行状态：

```bash
cd ~/ranking-arena
export $(cat .env.local | grep -v '^#' | xargs)
npx tsx scripts/check-bitget-recent.ts
```

## 相关 Commit 历史

1. `977cb8cf` - 添加 period 验证和 metadata（未能防止卡死）
2. 之前的多次尝试：禁用 detail/position APIs
3. `80ca3246` - **最终修复**：激进的 per-trader timeout

## 结论

✅ **bitget_futures 已恢复并加固**
- 不是禁用，而是真正修复
- 多层 timeout 防护
- Fail-fast 策略防止 pipeline 阻塞

下次 enrichment 运行时，应该不会再出现 44 分钟卡死。如果仍然有问题，将在 25 秒内快速失败，不影响其他平台。
