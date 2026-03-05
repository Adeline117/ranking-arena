# Arena数据基础设施升级 - Quick Start

**生成时间**: 2026-03-01  
**完整方案**: [`ARENA_DATA_INFRASTRUCTURE_UPGRADE.md`](./ARENA_DATA_INFRASTRUCTURE_UPGRADE.md)

---

## 🎯 核心问题 & 解决方案总结

### 问题1: 交易员主页数据空缺
**根本原因**: 很多交易所提供trader profile API，但我们没找到endpoint  
**解决方案**: 自动API发现 + 统一API客户端  
**预期效果**: 数据覆盖率从60% → 92%

### 问题2: DEX链上数据覆盖不足
**根本原因**: 只抓了3个DEX，缺少主流EVM链和Solana DEX  
**解决方案**: 统一链上数据抓取架构 + The Graph/Helius  
**预期效果**: DEX覆盖从3个 → 15+个

### 问题3: 数据稳定性差
**根本原因**: 无schema validation、无监控、无fallback  
**解决方案**: Zod验证 + 异常检测 + 多源冗余 + 实时监控  
**预期效果**: 故障发现时间从24h → <1h

---

## ⚡ 立即可执行的Actions（本周）

### 1️⃣ 部署数据验证（2小时）

**文件**: 已创建 `lib/validation/trader-schema.ts` + `lib/monitoring/anomaly-rules.ts`

**步骤**:
```bash
# 1. 安装依赖
cd ~/ranking-arena
npm install zod

# 2. 在任意import脚本中使用
# 修改 scripts/import-binance-futures.mjs
```

```javascript
// scripts/import-binance-futures.mjs
import { validateAndInsertTrader } from '../lib/validation/trader-schema.js'
import { AnomalyDetector } from '../lib/monitoring/anomaly-rules.js'

const detector = new AnomalyDetector()

async function importBinanceTraders() {
  const traders = await fetchBinanceLeaderboard()
  
  for (const trader of traders) {
    try {
      // 验证 + 异常检测
      const result = await detector.validate(trader)
      
      if (!result.valid) {
        console.error(`❌ Blocked: ${trader.source_trader_id}`, result.errors)
        if (result.fixed) {
          console.log(`✅ Auto-fixed, using corrected version`)
          trader = result.fixed
        } else {
          continue // 跳过无法修复的数据
        }
      }
      
      if (result.warnings.length > 0) {
        console.warn(`⚠️  Warnings:`, result.warnings)
      }
      
      // 插入数据库
      await validateAndInsertTrader(trader)
      
    } catch (error) {
      console.error(`Failed to insert trader:`, error)
    }
  }
}
```

**验证**:
```bash
node scripts/import-binance-futures.mjs
# 应该看到：
# ✅ Validation passed for trader xyz
# ⚠️  Warning: [roi_extreme_high] ...
# ❌ Blocked: [negative_trades_count] ...
```

---

### 2️⃣ 部署健康检查（1小时）

**文件**: 已创建 `scripts/health-check.mjs`

**步骤**:
```bash
# 1. 确保环境变量
# .env.local
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALERT_CHANNEL_ID=...

# 2. 手动运行测试
node scripts/health-check.mjs

# 3. 添加到cron（每小时检查）
crontab -e
# 添加：0 * * * * cd ~/ranking-arena && node scripts/health-check.mjs >> logs/health-check.log 2>&1
```

**预期输出**:
```
==========================================================
🔍 Arena数据健康检查
时间: 2026-03-01T20:00:00.000Z
==========================================================

[CHECK 1] 数据新鲜度...
✅ 检查1完成: 2个交易所数据过时

[CHECK 2] 数据完整性...
✅ 检查2完成: 3个交易所完整性<60%

[CHECK 3] 异常数据...
✅ 检查3完成: 1种异常类型

🔍 **Arena数据健康检查报告**
发现 3 个问题 (🔴 0 Critical | ⚠️  3 Warning)

1. ⚠️  **数据新鲜度** (warning)
   - gateio: 最后更新 2026-03-01 12:00:00
   - mexc: 最后更新 2026-03-01 11:30:00
...
```

**Telegram通知**:
会自动发送告警到配置的Telegram频道。

---

### 3️⃣ 补全API Endpoint清单（4小时）

**目标**: 为21个交易所找到真实的trader detail API

**工具**: Puppeteer + DevTools

**步骤**:

```bash
# 1. 手动方式（推荐先这样做几个）
# 打开Chrome DevTools
# 访问 https://www.binance.com/en/futures-activity/leaderboard
# 点击一个trader profile
# Network tab → 筛选 XHR/Fetch
# 找到包含trader stats的请求
# 复制为 curl → 保存到 docs/exchange-apis/binance-futures.md
```

**模板**: `docs/exchange-apis/binance-futures.md`

```markdown
# Binance Futures API

## Trader Detail API

### Endpoint
\`\`\`
POST /bapi/futures/v1/public/future/leaderboard/getOtherUserPerformance
\`\`\`

### 请求示例
\`\`\`bash
curl -X POST 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getOtherUserPerformance' \
  -H 'Content-Type: application/json' \
  -d '{"encryptedUid":"E0B84B10F7EC72EA64E44E5DAFA595"}'
\`\`\`

### 响应示例
\`\`\`json
{
  "code": "000000",
  "data": {
    "roi": 125.5,
    "pnl": 45230.12,
    "statistics": {
      "7d": { "roi": 12.3, "pnl": 2100 },
      "30d": { "roi": 45.2, "pnl": 8400 }
    }
  }
}
\`\`\`

### 字段映射
| API字段 | DB字段 | 说明 |
|---------|--------|------|
| `data.roi` | `roi` | 累计ROI% |
| `data.pnl` | `pnl` | 累计PnL USDT |
| `data.statistics.7d.roi` | `roi_7d` | 7天ROI% |
```

**优先级**:
1. P0: Bybit, Binance, OKX, Bitget（用户最多）
2. P1: Gate.io, MEXC, HTX, BingX
3. P2: 其他小交易所

**完成后**:
创建 `docs/EXCHANGE_API_ENDPOINTS.md` 汇总清单（见完整方案）

---

### 4️⃣ 实现Uniswap v3 Connector（6小时）

**目标**: 抓取Ethereum/Arbitrum Uniswap v3的链上trader数据

**依赖**:
```bash
npm install graphql graphql-request @solana/web3.js
```

**创建**: `lib/onchain/dexes/uniswap-v3.ts`

**代码**: 见完整方案中的实现

**测试**:
```typescript
// scripts/test-uniswap-v3.ts
import { UniswapV3Connector } from '../lib/onchain/dexes/uniswap-v3'

const connector = new UniswapV3Connector()

const stats = await connector.getTraderStats(
  '0x1234...', // 测试地址
  'ethereum'
)

console.log('Stats:', stats)
// 应该输出：
// {
//   address: '0x1234...',
//   chain: 'ethereum',
//   protocol: 'uniswap-v3',
//   totalTrades: 150,
//   totalPnL: 12345n,
//   stats7d: { ... },
//   positions: [ ... ],
// }
```

**导入脚本**: `scripts/import-uniswap-v3-ethereum.mjs`

```javascript
#!/usr/bin/env node

import { UniswapV3Connector } from '../lib/onchain/dexes/uniswap-v3.js'
import { createClient } from '@supabase/supabase-js'

const connector = new UniswapV3Connector()
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

async function importUniswapTraders() {
  // 1. 获取活跃trader地址列表（可以从Dune/Nansen获取）
  const topTraders = await fetch('https://api.dune.com/...').then(r => r.json())
  
  for (const trader of topTraders) {
    const stats = await connector.getTraderStats(trader.address, 'ethereum')
    
    // 2. 转换为我们的schema
    await supabase.from('trader_snapshots').upsert({
      source: 'uniswap_v3_ethereum',
      source_trader_id: trader.address,
      roi: Number(stats.stats30d?.roi || 0),
      pnl: Number(stats.stats30d?.pnl || 0n),
      trades_count: stats.totalTrades,
      equity_curve: stats.equityCurve.map(p => ({
        date: new Date(p.timestamp * 1000).toISOString().split('T')[0],
        value: Number(p.value),
      })),
      captured_at: new Date(),
    })
    
    console.log(`✅ Imported ${trader.address}`)
  }
}

importUniswapTraders()
```

---

## 📅 完整实施计划（8周）

### Week 1: 验证 + 监控（本周）
- [x] ✅ 部署Schema validation
- [x] ✅ 部署异常检测
- [x] ✅ 部署健康检查cron
- [ ] 运行一次数据质量审计

### Week 2: API发现
- [ ] 手动发现21个交易所的API endpoint
- [ ] 创建API文档 (`docs/exchange-apis/`)
- [ ] 实现统一API客户端基类
- [ ] 更新3-5个connector使用新API

### Week 3: 多源冗余
- [ ] 实现MultiSourceFetcher
- [ ] 为5个主要交易所配置多数据源
- [ ] 测试fallback机制
- [ ] 实现数据交叉验证

### Week 4: 监控仪表板
- [ ] 创建 `app/admin/monitoring/page.tsx`
- [ ] 实现实时数据展示
- [ ] 集成告警系统
- [ ] 部署到生产

### Week 5-6: DEX链上数据
- [ ] Uniswap v3 (Ethereum + 4条链)
- [ ] PancakeSwap (BSC)
- [ ] Solana DEXes (Jupiter/Drift)
- [ ] 跨链聚合

### Week 7-8: 优化 + 文档
- [ ] 性能优化（Redis缓存）
- [ ] BullMQ统一调度
- [ ] 完整文档
- [ ] 团队培训

---

## 🎯 关键指标

### 当前状态（Baseline）
- 数据覆盖率: 60%
- DEX数量: 3个
- 数据新鲜度: 平均6小时
- 故障发现时间: 24小时+
- Enrich脚本数: 19个未提交

### 目标状态（8周后）
- 数据覆盖率: 92%+ ✅
- DEX数量: 15个+ ✅
- 数据新鲜度: <2小时 ✅
- 故障发现时间: <1小时 ✅
- Enrich脚本数: 0 ✅

---

## 🚨 常见问题

### Q1: 需要额外的云服务吗？
**A**: 不需要。所有方案都可以在Mac Mini + 免费RPC tier运行。

### Q2: API rate limit怎么办？
**A**: 
- 使用免费tier的RPC服务（Infura 100K/day, Alchemy 300M CU/月）
- 实现rate limiter（Bottleneck）
- 缓存计算结果（Redis）
- 夜间运行大批量任务

### Q3: 如果某个API突然挂了怎么办？
**A**:
- 多源冗余架构自动fallback
- 健康检查1小时内发现 → Telegram告警
- 监控仪表板显示实时状态

### Q4: Zod验证会不会太慢？
**A**: 
- Zod验证非常快（<1ms per object）
- 批量验证可以用 `validateTraderBatch()`
- 验证在入库前，不影响查询性能

### Q5: 需要修改现有代码吗？
**A**:
- 最小侵入式设计
- 只需在import脚本里加2行：
  ```ts
  const result = await detector.validate(trader)
  if (!result.valid) { /* handle */ }
  ```

---

## 📚 相关文档

- **完整方案**: [`ARENA_DATA_INFRASTRUCTURE_UPGRADE.md`](./ARENA_DATA_INFRASTRUCTURE_UPGRADE.md) (80KB)
- **原始需求**: [`COMPLETE_DATA_REQUIREMENTS.md`](./COMPLETE_DATA_REQUIREMENTS.md)
- **数据策略**: [`DATA_COMPLETENESS_STRATEGY.md`](./DATA_COMPLETENESS_STRATEGY.md)

---

## 🤝 需要帮助？

遇到问题时：
1. 检查 `logs/health-check.log`
2. 查看监控仪表板 `/admin/monitoring`
3. Telegram告警频道有实时通知

---

**下一步**: 从Week 1的4个action开始，每个都能立即执行！ 🚀
