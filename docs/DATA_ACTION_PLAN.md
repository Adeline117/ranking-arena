# 数据完整性行动计划

> 基于 2026-03-06 三份审计报告：DATA_AUDIT_REPORT.md, ENRICHMENT_GAPS.md, PIPELINE_STABILITY.md

---

## 问题全景

### 按类别统计

| 类别 | 交易所数 | 有数据 | 数据完整 | 仅有排行榜 | 无enrichment | Stub/失效 |
|------|---------|--------|---------|-----------|-------------|----------|
| **合约 (Futures)** | 17 | 15 | 5 | 8 | 2 | 2 (LBank, Pionex) |
| **现货 (Spot)** | 5 | 5 | 2 | 3 | 0 | 0 |
| **链上 (OnChain)** | 9 | 7 | 3 | 2 | 2 | 2 (Kwenta, MUX 未注册) |

### 数据完整度定义
- **完整**: 排行榜 + enrichment + equity curve + 头像 + 三个时间段
- **仅排行榜**: 有 ROI/PnL 但缺 win_rate, max_drawdown, sharpe 等详细指标
- **无enrichment**: 在 LOWER_PRIORITY，从未被 enrich cron 调用

---

## P0: 关键修复 (影响核心体验)

### 1. Binance Futures snapshot 数据不完整
- **现状**: fetchTraderSnapshot 只取 ROI+PnL，win_rate/max_drawdown/followers/trades_count 全为 NULL
- **影响**: 最大交易所，交易员主页指标残缺
- **修复**: 在 snapshot 方法中增加 detail/base-info API 调用
- **文件**: `lib/connectors/platforms/binance-futures.ts`
- **工作量**: Medium

### 2. Hyperliquid ROI 永远为 0
- **现状**: fetchUserPnl 无法计算 ROI（缺初始权益），enrichment 中 roi=0
- **影响**: 最大 DEX，ROI 数据错误
- **修复**: 从 leaderboard discovery 阶段的 ROI 回填到 snapshot
- **文件**: `lib/connectors/platforms/hyperliquid-perp.ts`, enrichment pipeline
- **工作量**: Medium

### 3. BaseConnector 缺少 WAF/HTML 检测
- **现状**: response.json() 直接调用，CloudFlare 拦截页导致静默失败
- **影响**: 所有经过 CF 保护的交易所（Binance, OKX, HTX, BitMart 等）
- **修复**: 在 request() 中加 content-type 检查
- **文件**: `lib/connectors/base.ts`
- **工作量**: Low

### 4. 新 Connector 未接代理
- **现状**: platforms/*.ts 直连交易所 API，不走 CF Worker
- **影响**: 地域封锁区域（Binance, OKX, BingX）enrichment 全部失败
- **修复**: BaseConnector 加 proxyUrl 配置，per-connector 设置
- **文件**: `lib/connectors/base.ts`, 各 connector config
- **工作量**: Medium

---

## P1: 高优先级 (影响数据覆盖)

### 5. LOWER_PRIORITY 平台永远不被 enrich
- **现状**: kucoin, gains, jupiter_perps, aevo 不在任何 enrich cron 中
- **影响**: 4 个交易所无详细指标
- **修复**: 添加 cron `batch-enrich?all=true&period=90D` 每周两次
- **文件**: `vercel.json`
- **工作量**: Low

### 6. BitMart 未进入 cron 调度
- **现状**: Connector 已注册但未加入任何 batch-fetch-traders group
- **影响**: BitMart 交易员数据完全缺失
- **修复**: 加入 group D 或 E
- **文件**: `app/api/cron/batch-fetch-traders/route.ts`
- **工作量**: Low

### 7. Kwenta/MUX connector 未注册
- **现状**: 完整 connector 代码存在但未在 registry 注册，也未进 cron
- **影响**: 2 个 DEX 数据完全缺失
- **修复**: 在 initializeConnectors() 注册 + 加入 cron group
- **文件**: `lib/connectors/registry.ts`, `app/api/cron/batch-fetch-traders/route.ts`
- **工作量**: Low

### 8. 6 个平台缺少头像 backfill cron
- **现状**: binance_spot, bitget_spot, weex, phemex, blofin, xt 有 avatar fetcher 但无 cron
- **影响**: 这些平台交易员无头像
- **修复**: 在 vercel.json 添加 6 个 avatar backfill cron
- **文件**: `vercel.json`
- **工作量**: Low

### 9. Jupiter/Aevo 不在 enrichment 配置中
- **现状**: 在 batch-fetch group B 但不在 batch-enrich PLATFORM_CONFIGS
- **影响**: 有排行榜数据但无详细指标
- **修复**: 加入 LOWER_PRIORITY enrichment 配置
- **文件**: `app/api/cron/batch-enrich/route.ts`
- **工作量**: Low

---

## P2: 数据质量提升

### 10. Equity Curve 覆盖率低
- **现状**: 仅 5/27 交易所有 equity curve (Binance, Bybit, OKX, Bitget, HTX)
- **影响**: 大部分交易所无法计算 volatility/sharpe/sortino/calmar
- **修复**: 为 MEXC, CoinEx, KuCoin 调研 API 是否支持历史数据
- **工作量**: High (需逐个交易所调研 API)

### 11. BingX ROI/PnL 永远 NULL
- **现状**: search API 不返回 roi/pnl
- **影响**: BingX 交易员核心指标缺失
- **修复**: 找到 detail API endpoint 或用 trader-detail CF Worker endpoint
- **文件**: `lib/connectors/bingx-spot-enrichment.ts`
- **工作量**: Medium

### 12. OKX/Binance Spot trades_count 为 NULL
- **现状**: API 可能提供但 connector 未解析
- **修复**: 检查 API response，添加 trades_count 字段解析
- **文件**: `lib/connectors/platforms/okx-futures.ts`, `lib/connectors/binance-spot.ts`
- **工作量**: Low

### 13. Gains discoverLeaderboard 只找有仓位的
- **现状**: 从 /open-trades 获取交易员，空仓交易员被遗漏
- **修复**: 改用 /leaderboard/all endpoint (CF Worker 已支持)
- **文件**: `lib/connectors/platforms/gains-perp.ts`
- **工作量**: Low

---

## P3: 管道稳定性

### 14. HTX/BitMart/WEEX/Gate.io/XT 无代理
- **现状**: scraping difficulty 3-4 但无 proxy fallback
- **修复**: 添加到 CF Worker ALLOWED_HOSTS + 配置 proxy URL
- **文件**: `cloudflare-worker/src/index.ts`, connector configs
- **工作量**: Medium

### 15. Stub connector 浪费 cron 执行时间
- **现状**: LBank, Pionex 永远返回空数据但仍在 cron group 中
- **修复**: 从 batch-fetch-traders group 中移除或标记 disabled
- **文件**: `app/api/cron/batch-fetch-traders/route.ts`
- **工作量**: Low

### 16. Freshness 监控不覆盖新平台
- **现状**: enrichment freshness 只监控 11 个平台
- **修复**: 添加 BingX, BloFin, Gate.io, WEEX, BitMart 到 freshness check
- **文件**: `app/api/cron/check-enrichment-freshness/route.ts`
- **工作量**: Low

---

## P4: 新来源计划

### 准备就绪 (仅需配置)
| 交易所 | 所需操作 | 预计交易员数 |
|--------|---------|:----------:|
| Drift (Solana) | 设置 DRIFT_API_KEY 环境变量 | ~500-1000 |
| Synthetix V3 (Base) | 设置 THEGRAPH_API_KEY | ~300-500 |

### 已有 fetcher 但需完善
| 交易所 | 状态 | 需要的工作 |
|--------|------|-----------|
| Toobit, BTSE, Crypto.com | Config-driven fetcher | 添加 connector 以支持 enrichment |
| Bitfinex, WhiteBIT | Inline fetcher | 同上 |
| Uniswap, PancakeSwap | DEX fetcher | 同上 |

### 未来可考虑
| 交易所 | 难度 | 备注 |
|--------|------|------|
| Vertex Protocol | Very High | 无公开 API |
| Zeta Markets (Solana) | Medium | Solana perps DEX |
| Orderly Network | Medium | 多链 DEX |
| Dune Analytics (4 sources) | High | 需 API key + query |

---

## 永远为 NULL 的字段 (设计决策)

这些 DB 列存在但无任何 connector 填充，需决定是否保留：

| 字段 | 状态 | 建议 |
|------|------|------|
| sortino_ratio | 可从 equity curve 计算 | 保留，扩展 calculate-advanced-metrics |
| calmar_ratio | 可从 equity curve + MDD 计算 | 保留，同上 |
| profit_factor | 需 position history | 保留，对有 position 数据的交易所计算 |
| recovery_factor | 需 net profit + MDD | 保留，同上 |
| max_consecutive_wins/losses | 需 position level 数据 | 保留，对有 position 数据的交易所计算 |
| beta_btc/beta_eth/alpha | 需市场相关性计算 | 暂搁置，基础设施不完善 |
| downside_volatility_pct | 可从 equity curve 计算 | 保留，扩展 calculate-advanced-metrics |
| asset_preference | 需 position 分析 | 暂搁置 |

---

## 执行优先级总结

| 优先级 | 任务数 | 总工作量 | 预计影响 |
|--------|-------|---------|---------|
| **P0 关键修复** | 4 | 3-4 天 | 修复核心数据错误 |
| **P1 高优先级** | 5 | 1-2 天 | 扩展数据覆盖 |
| **P2 质量提升** | 4 | 3-5 天 | 提升指标完整性 |
| **P3 稳定性** | 3 | 1-2 天 | 减少静默失败 |
| **P4 新来源** | 若干 | 持续 | 扩展平台覆盖 |

---

## 三个页面 × 三个时间段 数据需求矩阵

### 排行榜页面 (/rankings)
| 字段 | 7D | 30D | 90D | 来源 |
|------|:--:|:---:|:---:|------|
| rank | Y | Y | Y | compute-leaderboard |
| arena_score | Y | Y | Y | compute-leaderboard |
| roi | Y | Y | Y | batch-fetch-traders |
| pnl | Y | Y | Y | batch-fetch-traders |
| win_rate | - | - | - | batch-enrich (缺: Binance, Hyperliquid, dYdX) |
| max_drawdown | - | - | - | batch-enrich (缺: Binance, BingX, dYdX) |
| avatar | - | - | - | backfill-avatars (缺 6 平台) |
| handle | - | - | - | batch-fetch-traders |

### 交易员主页 (/trader/[handle])
| 字段 | 需求 | 覆盖率 | 主要缺口 |
|------|------|--------|---------|
| ROI 曲线 | equity_curve | 5/27 | MEXC, KuCoin, CoinEx, DEX 全缺 |
| 持仓历史 | position_history | 6/27 | 多数 CEX 和 DEX 缺失 |
| 详细统计 | stats_detail | 5/27 | 仅 Binance/Bybit/OKX/Bitget/HTX |
| 头像 | avatar_url | ~15/27 | DEX 全缺，6 CEX 缺 backfill |
| 社交数据 | followers/copiers | ~10/27 | DEX 不适用，部分 CEX 缺失 |
| 交易风格 | trading_style | 有计算 | 依赖 equity curve 和 position data |

### 交易员原平台头像
| 状态 | 平台数 | 平台列表 |
|------|--------|---------|
| 有头像 + 有 backfill cron | 10 | Binance Futures, Bybit, Bitget Futures, OKX, MEXC, KuCoin, HTX, BingX, CoinEx, LBank |
| 有 fetcher 但无 cron | 6 | Binance Spot, Bitget Spot, WEEX, Phemex, BloFin, XT |
| 无头像 (DEX) | 9 | Hyperliquid, dYdX, GMX, Gains, Jupiter, Aevo, Kwenta, MUX, Uniswap |
| 无头像 (CEX) | 2 | Gate.io, BitMart |
