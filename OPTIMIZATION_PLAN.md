# Arena 全面优化补全计划
> 生成于 2026-03-19 | 基于 6 个并行 Agent 深度审查

---

## 一、总览

| 维度 | 审查项 | 完整度 | 关键发现 |
|------|--------|--------|---------|
| 首页 | 8 个数据区域 | 92% | exchangeCount 硬编码, MarketPanel 废弃代码, 搜索仅覆盖 200 trader |
| 排行榜 | 27 个交易所页 | 85% | 无 7D/30D 切换, 无所内搜索, PnL 仅 card 视图, 无 followers 列 |
| 交易员详情 | 12 个维度 | 90% | Compare 未集成, Market Correlation 空数据, Advanced Metrics 用旧数据 |
| 数据质量 | 27 平台 × 8 指标 | 88% | bitget_futures 无 cron, lbank 无 enrichment 配置, 诊断脚本用 v1 表 |
| UX/功能 | 35+ 页面 | 93% | next/image 仅 5 文件, 无 hreflang, 无 copy trade 执行, 无 funding rate 页 |
| Pipeline | 60 cron × 26 enrichment | 95% | 3 平台无 enrichment, position history 仅 13/27 平台 |

---

## 二、P0 — 必须修复 (影响核心体验)

### 2.1 数据管道

| # | 问题 | 位置 | 修复方案 |
|---|------|------|---------|
| P0-1 | **bitget_futures 无 cron 触发** — 排行榜数据无自动刷新 | `vercel.json` | 添加 `fetch-traders/bitget_futures` cron 或恢复 group a4 |
| P0-2 | **lbank 无 enrichment 配置** — 既不在 ENRICHMENT 也不在 NO_ENRICHMENT | `enrichment-runner.ts` | 加入 `NO_ENRICHMENT_PLATFORMS` |
| P0-3 | **诊断脚本用 v1 表** — pipeline-health-check + check-data-distribution 查询废弃表 | `scripts/` | 迁移到 `trader_snapshots_v2` + `leaderboard_ranks` |

### 2.2 交易员详情页

| # | 问题 | 位置 | 修复方案 |
|---|------|------|---------|
| P0-4 | **Compare 功能未集成** — Zustand store + FloatingBar 存在但页面无 "加入对比" 按钮 | `TraderProfileClient.tsx` | 在 TraderHeader 添加 "Compare" 按钮, 调用 `useComparisonStore` |
| P0-5 | **Market Correlation Card 空数据** — beta_btc/beta_eth/alpha 从未被计算 | `enrichment-runner.ts` | 选项 A: 实现计算逻辑; 选项 B: 移除该组件减少代码 |
| P0-6 | **Advanced Metrics 用旧数据** — 读 server prop 而非 SWR 刷新数据 | `TraderProfileClient.tsx` | 改为从 `traderPerformance` (SWR) 读取 sortino/calmar/profit_factor |
| P0-7 | **RankTrendSparkline 未传 props** — platform/traderKey 未传给 TraderHeader | `TraderProfileClient.tsx` | 传递 `platform` 和 `traderKey` props |

### 2.3 排行榜

| # | 问题 | 位置 | 修复方案 |
|---|------|------|---------|
| P0-8 | **交易所页无周期切换** — 硬编码 90D, 无 7D/30D 选项 | `ExchangeRankingClient.tsx` | 添加 TimeRangeSelector, 支持 7D/30D/90D URL 同步 |
| P0-9 | **交易所页无搜索** — 5000 trader 无法搜索特定人 | `ExchangeRankingClient.tsx` | 添加搜索输入框, 客户端过滤 |

---

## 三、P1 — 应该修复 (提升完整度)

### 3.1 排行榜补全

| # | 问题 | 修复方案 |
|---|------|---------|
| P1-1 | PnL 列仅 card 视图可见, table 视图缺失 | 在 table 添加 PnL 列 |
| P1-2 | followers/copiers 数据已获取但从不显示 | 添加可选 Followers 列 |
| P1-3 | sharpe_ratio 列缺失 | 添加可选 Sharpe 列 |
| P1-4 | trades_count 列缺失 | 添加可选 Trades 列 |
| P1-5 | 无 "所有交易所" 索引页 (`/rankings`) | 创建交易所卡片网格页, 显示每所统计 |

### 3.2 交易员详情补全

| # | 问题 | 修复方案 |
|---|------|---------|
| P1-6 | Drawdown + Daily Returns 锁定 90D, 不跟随周期选择器 | 读取当前 period 的 equity curve |
| P1-7 | 周期选择不反映在 URL | 添加 `?period=7D` URL 参数同步 |
| P1-8 | Copy-trade 链接缺失 9 个交易所 (MEXC, Gate, BingX, Phemex, Blofin, Coinex, BTCC, Bitfinex, XT) | 补充每所的 copy-trade/view URL |
| P1-9 | 无评论/评价系统 | 添加 trader 页评论区 (类似 posts) |
| P1-10 | `getCopyTradeUrl()` 逻辑重复在两个文件 | 提取到 `lib/utils/copy-trade.ts` |

### 3.3 首页补全

| # | 问题 | 修复方案 |
|---|------|---------|
| P1-11 | exchangeCount=27 硬编码 | 从 `leaderboard_ranks` distinct sources 查询 |
| P1-12 | "30m" hero stat 误导 (30 分钟 vs 30 million 歧义) | 改为动态显示实际刷新频率或改标签 |
| P1-13 | 搜索仅覆盖已加载的 200 trader | 添加 server-side search 回退 (Meilisearch 或 Supabase trigram) |
| P1-14 | MarketPanel.tsx 废弃代码 | 删除 (WatchlistMarket 已替代) |
| P1-15 | movers API `rankChange` 字段名误导 (实际是 ROI delta) | 改名为 `roiDelta` |

### 3.4 数据管道

| # | 问题 | 修复方案 |
|---|------|---------|
| P1-16 | bybit_spot 无 cron 条目 (group a3 未在 vercel.json) | 验证数据新鲜度, 必要时添加 cron |
| P1-17 | bitget_futures enrichment 仅 equity curve (stats/positions 挂起) | 定期重测 Bitget API, 尝试恢复 |

---

## 四、P2 — 优化提升 (竞争力)

### 4.1 性能

| # | 优化 | 预期效果 |
|---|------|---------|
| P2-1 | **next/image 批量迁移** — 仅 5 文件使用, 其余用 raw `<img>` | WebP/AVIF 自动转换, 懒加载, blur placeholder |
| P2-2 | **hreflang 标签** — 4 种语言无 SEO 发现 | 添加 `<link rel="alternate" hreflang="en/zh/ja/ko">` |
| P2-3 | **日语翻译补全** — 比其他语言少 ~280 个 key | 补全 `ja.ts` 缺失的翻译 |
| P2-4 | **Layout revalidate 不匹配** — layout 3600s vs page 300s | 统一为 300s 或移除 layout 的 revalidate |

### 4.2 新功能 (竞品对标)

| # | 功能 | 竞品参考 | 优先级 |
|---|------|---------|--------|
| P2-5 | **Funding Rate 页面** — 数据 cron 已有, 缺 UI | Copin.io | Medium |
| P2-6 | **Open Interest 页面** — 数据 cron 已有, 缺 UI | Copin.io | Medium |
| P2-7 | **Token/交易对排行** — "谁交易 BTC 最好" | Copin.io | Medium |
| P2-8 | **Library 浏览页** — 60K 资源仅搜索可达, 无浏览入口 | - | Medium |
| P2-9 | **自定义 Watchlist 页** — API 已有, 缺独立页面 | DeBank | Medium |
| P2-10 | **Referral 系统 UI** — API 已有, 缺入口 | Zignaly | Medium |

### 4.3 商业化

| # | 项目 | 状态 |
|---|------|------|
| P2-11 | **Pro 付费墙启用** — `BETA_PRO_FEATURES_FREE = true` 意味零收入 | 确定 launch 日期后关闭 |
| P2-12 | **Copy Trading 执行** — 模拟器存在但无实际执行 | 竞品核心差异化, 需 exchange API 集成 |

---

## 五、每交易所数据矩阵

| 交易所 | 排行 | Equity | Stats | Positions | Portfolio | Copy Link | Cron |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| binance_futures | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| bybit | ✅ | ✅ VPS | ✅ VPS | ❌ | ❌ | ✅ | ✅ |
| okx_futures | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| bitget_futures | ✅ | ✅ | ❌ hang | ❌ hang | ❌ | ✅ | ⚠️ 无cron |
| hyperliquid | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ DEX | ✅ |
| gmx | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ DEX | ✅ |
| mexc | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| htx_futures | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| gateio | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ 缺 | ✅ |
| dydx | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ DEX | ✅ |
| drift | ✅ | ✅ | ✅ | ✅ S3 | ❌ | ✅ DEX | ✅ |
| aevo | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ DEX | ✅ |
| gains | ✅ | ✅ on | ✅ on | ✅ on | ❌ | ✅ DEX | ✅ |
| jupiter_perps | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ DEX | ✅ |
| etoro | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| coinex | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| bingx | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| xt | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| blofin | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| btcc | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| bitfinex | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| phemex | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| toobit | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| bitunix | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ 缺 | ✅ |
| binance_spot | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| okx_spot | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| kucoin | ✅ | DB | ❌ | ❌ | ❌ | ❌ | ✅ |
| weex | ✅ | DB | ❌ | ❌ | ❌ | ❌ | ✅ |

**图例**: ✅ 完整 | ⚠️ 风险 | ❌ 缺失 | DB = 从日快照派生 | VPS = 通过 VPS 抓取 | on = 链上

---

## 六、指标覆盖率

| 指标 | 当前覆盖率 | 目标 |
|------|-----------|------|
| ROI | ~100% | ✅ |
| PnL | ~100% | ✅ |
| Win Rate | 94.5% | ✅ >80% |
| Max Drawdown | 95.1% | ✅ >80% |
| Sharpe Ratio | 83.8% | ✅ >80% |
| Sortino Ratio | ~30% (推算) | ❌ 需提升 |
| Calmar Ratio | ~30% (推算) | ❌ 需提升 |
| Followers | ~40% (CEX only) | ℹ️ 平台限制 |
| Trades Count | ~60% | ℹ️ |
| AUM | ~10% | ❌ 需提升 |
| Beta (BTC/ETH) | ~0% | ❌ 未实现 |
| Alpha | ~0% | ❌ 未实现 |

---

## 七、执行优先级路线图

### Sprint 1 (立即)
- [ ] P0-1: bitget_futures cron 修复
- [ ] P0-2: lbank NO_ENRICHMENT 配置
- [ ] P0-4: Compare 按钮集成到 trader 页
- [ ] P0-6: Advanced Metrics 改用 SWR 数据
- [ ] P0-7: RankTrendSparkline 传 props
- [ ] P0-8: 交易所页添加周期切换
- [ ] P0-9: 交易所页添加搜索

### Sprint 2 (本周)
- [ ] P0-3: 诊断脚本迁移 v2
- [ ] P0-5: Market Correlation 决策 (实现 or 移除)
- [ ] P1-1~4: 排行榜补充 PnL/Followers/Sharpe/Trades 列
- [ ] P1-5: 创建 /rankings 索引页
- [ ] P1-6~7: Drawdown 周期 + URL 同步
- [ ] P1-8: 补充 9 个交易所 copy-trade 链接
- [ ] P1-10: getCopyTradeUrl 去重

### Sprint 3 (下周)
- [ ] P1-11~15: 首页细节修复
- [ ] P1-16~17: 数据管道验证
- [ ] P2-1: next/image 批量迁移
- [ ] P2-2: hreflang 标签
- [ ] P2-3: 日语翻译补全

### Sprint 4 (下下周)
- [ ] P2-5~6: Funding Rate + OI 页面
- [ ] P2-7: Token 排行
- [ ] P2-8~10: Library/Watchlist/Referral 页面
- [ ] P2-4: Layout revalidate 统一

### 里程碑
- [ ] P2-11: Pro 付费墙启用 (需商业决策)
- [ ] P2-12: Copy Trading 执行 (大型项目, 需专项规划)

---

## 八、竞品优势 vs 差距

### Arena 领先
- 最广交易所覆盖 (25 平台, CEX + DEX)
- Arena Score 创新复合指标
- 完整社交层 (群组/DM/帖子)
- 原生移动 App (Capacitor)
- 4 语言 i18n
- 成熟 Pipeline 自动化 (60 cron, 自愈)

### Arena 落后 (vs Copin.io/Zignaly/DeBank)
- ❌ 无一键 Copy Trading 执行
- ❌ 无 Token/交易对排行
- ❌ 无 Funding Rate/OI 页面
- ❌ Beta/Alpha 市场相关性未计算
- ⚠️ next/image 采用率极低
- ⚠️ Pro 付费墙未启用

---

*此计划基于 6 个并行 Agent 的全面代码审查生成, 覆盖 100+ 文件, 27 个交易所, 35+ 页面, 60 个 cron 任务。*
