# Ranking Arena 数据覆盖分析报告

**分析日期**: 2026-01-30  
**分析范围**: traders 表、trader_snapshots 表、trader_snapshots_v2 表、全部 connectors、cron 调度

---

## 1. 当前数据统计总览

### 1.1 核心数据量

| 指标 | 数值 |
|------|------|
| traders 表总量 | 7 (仅手动创建，source=NULL) |
| trader_snapshots 总量 | 13,779 |
| trader_snapshots_v2 总量 | 16,200 |
| 唯一交易员数（snapshots） | 7,318 |
| 数据源数量 | 23 个 |
| 活跃 connector 目录 | 18 个 |
| cron 调度平台 | 28+ 个任务 |

### 1.2 各 Source 的交易员/快照数量

#### trader_snapshots（V1 主表）

| Source | 快照数 | 唯一交易员 | 平均快照/人 | 最近更新 |
|--------|--------|------------|-------------|----------|
| binance_futures | 2,091 | 808 | 2.6 | 01-26 ✅ |
| gmx | 1,870 | 768 | 2.4 | 01-30 ✅ |
| gains | 1,276 | 598 | 2.1 | 01-30 ✅ |
| htx_futures | 1,076 | 590 | 1.8 | 01-30 ✅ |
| bitget_futures | 936 | 517 | 1.8 | 01-26 ⚠️ |
| mexc | 887 | 547 | 1.6 | 01-30 ✅ |
| coinex | 790 | 308 | 2.6 | 01-30 ✅ |
| okx_web3 | 747 | 596 | 1.3 | 01-28 ✅ |
| okx_futures | 732 | 246 | 3.0 | 01-30 ✅ |
| kucoin | 646 | 350 | 1.8 | 01-30 ✅ |
| binance_spot | 568 | 365 | 1.6 | 01-26 ⚠️ |
| bybit | 560 | 325 | 1.7 | 01-30 ✅ |
| xt | 500 | 500 | 1.0 | 01-30 ✅ |
| hyperliquid | 395 | 373 | 1.1 | 01-30 ✅ |
| bitget_spot | 234 | 109 | 2.1 | 01-28 ✅ |
| dydx | 164 | 83 | 2.0 | 01-26 ⚠️ |
| binance_web3 | 153 | 123 | 1.2 | 01-28 ✅ |
| weex | 69 | 37 | 1.9 | 01-28 ✅ |
| lbank | 41 | 41 | 1.0 | 01-28 ✅ |
| phemex | 20 | 10 | 2.0 | 01-30 ✅ |
| htx | 10 | 10 | 1.0 | 01-25 ⚠️ |
| blofin | 10 | 10 | 1.0 | 01-28 ✅ |
| bingx | 4 | 4 | 1.0 | 01-30 ✅ |

#### trader_snapshots_v2（新架构表）

| Platform | Market Type | 快照数 |
|----------|------------|--------|
| gmx | perp | 8,100 |
| hyperliquid | perp | 8,100 |
| **其他全部** | - | **0** |

> ⚠️ V2 表仅 DeFi 链上数据在写入，CeFi 平台完全为空。

### 1.3 字段覆盖率（trader_snapshots V1 全局）

| 字段 | 覆盖数 | 覆盖率 | 状态 |
|------|--------|--------|------|
| rank | 11,955 | 86.8% | ✅ 良好 |
| arena_score | 12,702 | 92.2% | ✅ 良好 |
| roi | 11,861 | 86.1% | ✅ 良好 |
| followers | 9,301 | 67.5% | ⚠️ 中等 |
| pnl | 8,542 | 62.0% | ⚠️ 中等 |
| win_rate | 7,759 | 56.3% | ⚠️ 中等 |
| max_drawdown | 5,881 | 42.7% | ❌ 较差 |
| trades_count | 1,685 | 12.2% | ❌ 很差 |
| **pnl_7d** | **0** | **0.0%** | ❌ 未实现 |
| **pnl_30d** | **0** | **0.0%** | ❌ 未实现 |
| **win_rate_7d** | **0** | **0.0%** | ❌ 未实现 |
| **win_rate_30d** | **0** | **0.0%** | ❌ 未实现 |
| **max_drawdown_7d** | **0** | **0.0%** | ❌ 未实现 |
| **max_drawdown_30d** | **0** | **0.0%** | ❌ 未实现 |
| **holding_days** | **0** | **0.0%** | ❌ 未实现 |

### 1.4 各 Source 字段覆盖率明细

| Source | ROI | PNL | Win Rate | Max DD | Trades | Followers |
|--------|-----|-----|----------|--------|--------|-----------|
| binance_futures | 100% | 100% | 100% | 100% | 0% | 100% |
| htx_futures | 100% | 94% | 100% | 86% | 0% | 94% |
| okx_futures | 100% | 89% | 95% | 75% | 0% | 54% |
| weex | 100% | 81% | 100% | 0% | 0% | 94% |
| bybit | 85% | 62% | 76% | 47% | 0% | 62% |
| kucoin | 83% | 93% | 63% | 93% | 63% | 1% |
| gmx | 99% | 86% | 81% | 19% | 0% | 33% |
| bitget_futures | 91% | 7% | 59% | 48% | 0% | 46% |
| coinex | 82% | 25% | 25% | 0% | 0% | 32% |
| mexc | 97% | 7% | 7% | 7% | 0% | 97% |
| dydx | 100% | 100% | 1% | 2% | 0% | 100% |
| hyperliquid | 100% | 100% | 14% | 16% | 0% | 100% |
| binance_spot | 85% | 85% | 85% | 85% | 0% | 85% |
| bitget_spot | 100% | 8% | 40% | 0% | 0% | 47% |
| okx_web3 | 98% | 98% | 0% | 0% | 0% | 98% |
| binance_web3 | 34% | 0% | 0% | 0% | 0% | 34% |
| **gains** | **2%** | **2%** | **2%** | **0%** | **100%** | **100%** |
| **xt** | **100%** | **0%** | **0%** | **0%** | **0%** | **0%** |
| **bingx** | **100%** | **0%** | **0%** | **0%** | **0%** | **0%** |
| **lbank** | **100%** | **0%** | **0%** | **61%** | **0%** | **0%** |
| **blofin** | **100%** | **0%** | **0%** | **60%** | **0%** | **0%** |
| **phemex** | **100%** | **100%** | **0%** | **0%** | **0%** | **0%** |
| htx (legacy) | 100% | 100% | 100% | 100% | 0% | 100% |

---

## 2. 数据源分析

### 2.1 Connector 目录 vs 实际使用状态

| Connector | 目录存在 | Cron 调度 | 有快照数据 | 状态 |
|-----------|---------|----------|-----------|------|
| binance/futures | ✅ | ✅ | ✅ 2,091 | 🟢 正常运行 |
| binance/spot | ✅ | ✅ | ✅ 568 | 🟢 正常运行 |
| binance/web3 | ✅ | ✅ | ✅ 153 | 🟡 数据稀疏 |
| bybit | ✅ | ✅ | ✅ 560 | 🟢 正常运行 |
| bitget/futures | ✅ | ✅ | ✅ 936 | 🟢 正常运行 |
| bitget/spot | ✅ | ✅ | ✅ 234 | 🟢 正常运行 |
| mexc | ✅ | ✅ | ✅ 887 | 🟡 字段覆盖差 |
| coinex | ✅ | ✅ | ✅ 790 | 🟡 字段覆盖差 |
| okx/futures | ✅ | ✅ | ✅ 732 | 🟢 正常运行 |
| okx/wallet(web3) | ✅ | ✅ | ✅ 747 | 🟡 缺 win_rate/drawdown |
| kucoin | ✅ | ✅ | ✅ 646 | 🟢 正常运行 |
| htx | ✅ | ✅ | ✅ 1,076 | 🟢 正常运行 |
| weex | ✅ | ✅ | ✅ 69 | 🟡 数据量少 |
| phemex | ✅ | ✅ | ✅ 20 | 🔴 数据极少 |
| bitmart | ✅ | ❌ 无调度 | ❌ 0 | 🔴 完全未使用 |
| gmx | ✅ | ✅ | ✅ 1,870 | 🟢 正常运行 |
| dydx | ✅ | ❌ 无专属调度 | ✅ 164 | 🟡 数据量少 |
| hyperliquid | ✅ | ❌ 无专属调度 | ✅ 395 | 🟡 依赖V2管道 |
| nansen | ✅ | ❌ | ❌ 0 | ⬜ 仅 enrichment |
| dune/* | ✅ | ❌ | ❌ 0 | ⬜ 仅 enrichment |

### 2.2 有 Cron 调度但无 Connector 目录的平台（仅靠 import 脚本）

| 平台 | Cron 调度 | Import 脚本 | 快照数据 | 问题 |
|------|----------|-------------|---------|------|
| xt | ✅ 4h | import_xt.mjs | 500 | 只有 ROI，无其他字段 |
| bingx | ✅ 4h | import_bingx.mjs | 4 | 几乎无数据 |
| gains | ✅ 4h | import_gains.mjs | 1,276 | ROI/PNL 仅2%覆盖 |
| lbank | ✅ 4h | import_lbank.mjs | 41 | 只有 ROI |
| blofin | ✅ 4h | import_blofin.mjs | 10 | 极少数据 |
| gateio | ✅ 4h | import_gateio.mjs | **0** | 🔴 调度存在但无数据 |
| pionex | ✅ 4h | import_pionex.mjs | **0** | 🔴 调度存在但无数据 |
| kwenta | ✅ 4h | import_kwenta.mjs | **0** | 🔴 调度存在但无数据 |
| mux | ✅ 4h | import_mux.mjs | **0** | 🔴 调度存在但无数据 |

### 2.3 各 Connector 抓取逻辑摘要

| Connector | 数据获取方式 | API 类型 | 窗口支持 | ROI 排序 |
|-----------|-------------|---------|----------|----------|
| binance/futures | POST bapi 内部API | REST (public) | 7D/30D/90D | ✅ 服务端 |
| binance/spot | POST bapi 内部API | REST (public) | 7D/30D/90D | ✅ 服务端 |
| binance/web3 | POST bapi 内部API | REST (public) | 7D/30D/90D | 客户端 |
| bybit | GET api2 公开API | REST (public) | 7D/30D/90D | ✅ 服务端 |
| bitget | POST v1 触发器API | REST (public) | 7D/30D/90D | ✅ 服务端 |
| mexc | 未知（仅脚本） | 可能是爬虫 | 7D/30D/90D | 未知 |
| coinex | 未知（仅脚本） | 可能是爬虫 | 7D/30D/90D | 未知 |
| okx/futures | GET priapi 公开API | REST (public) | 7D/30D/90D | ✅ 服务端 |
| okx/wallet | GET priapi 公开API | REST (public) | 7D/30D/90D | 默认排序 |
| kucoin | 未知（仅脚本） | 可能是爬虫 | 7D/30D/90D | 未知 |
| htx | 未知（仅脚本） | REST | 7D/30D/90D | 未知 |
| gmx | GraphQL (Subsquid) | GraphQL subgraph | 累计数据 | 客户端排序 |
| dydx | GET indexer API | REST (public) | 7D/30D/90D | 客户端排序 |
| hyperliquid | POST info API / stats | REST (public) | 7D/30D/allTime | 客户端排序 |

---

## 3. 缺失数据识别

### 3.1 数据最少的平台（急需优化）

| 排名 | 平台 | 快照数 | 问题描述 |
|------|------|--------|---------|
| 1 | **gateio** | 0 | cron 调度存在但零数据产出 |
| 2 | **pionex** | 0 | cron 调度存在但零数据产出 |
| 3 | **kwenta** | 0 | cron 调度存在但零数据产出 |
| 4 | **mux** | 0 | cron 调度存在但零数据产出 |
| 5 | **bitmart** | 0 | 有 connector 但无 cron 调度 |
| 6 | bingx | 4 | 几乎无效数据 |
| 7 | blofin | 10 | 极少数据 |
| 8 | phemex | 20 | 数据极少 |
| 9 | lbank | 41 | 数据少，字段单一 |
| 10 | weex | 69 | 数据量不足 |

### 3.2 字段缺失最严重的

| 排名 | 字段 | 全局覆盖率 | 影响 |
|------|------|-----------|------|
| 1 | pnl_7d/30d, win_rate_7d/30d, max_drawdown_7d/30d | **0%** | 时间窗口维度完全缺失 |
| 2 | holding_days | **0%** | 持仓天数无数据 |
| 3 | trades_count | **12.2%** | 仅 kucoin(63%)和 gains(100%) 有 |
| 4 | max_drawdown | **42.7%** | 7个平台完全缺失(0%) |
| 5 | win_rate | **56.3%** | 多个平台 <10% |
| 6 | pnl | **62.0%** | xt/bingx/lbank/blofin 完全缺失 |

**按平台的字段空洞：**
- **gains**: 1,276条数据但 ROI/PNL/win_rate 覆盖仅 2%（只有 trades_count 和 followers）
- **xt**: 500条数据但仅有 ROI（其他全为空）
- **mexc**: 887条但 PNL/win_rate/max_dd 仅 7%
- **coinex**: 790条但 PNL/win_rate 仅 25%, max_dd=0%
- **okx_web3**: 747条但 win_rate=0%, max_dd=0%
- **binance_web3**: ROI 仅 34%，其他全 0%

### 3.3 数据质量问题

| 问题类型 | 严重程度 | 详情 |
|----------|---------|------|
| 异常值 | ✅ 无问题 | ROI/PNL 无极端异常值，win_rate 无越界 |
| 重复数据 | ⚠️ 存在 | bitget_futures 多个 trader 有 4 条重复快照（多窗口） |
| traders 表空虚 | ❌ 严重 | 仅 7 条记录，source 全为 NULL，与 snapshots 完全脱节 |
| V2 表迁移不完整 | ⚠️ | V2 仅有 GMX/Hyperliquid 数据，CeFi 平台完全空 |
| profiles_v2 表空 | ❌ | 0 条 profile 数据 |
| 时间窗口字段未填充 | ❌ 严重 | 所有 _7d/_30d 维度字段均为 0% |
| refresh_jobs 失败 | ⚠️ | 162 个失败任务（vs 805 完成），7 个仍在运行 |

---

## 4. 针对性优化方案

### 4.1 高优先级：修复零数据平台

#### Gate.io（gateio）- 🔴 零数据
- **问题**: cron 调度 `import_gateio.mjs` 存在但不产出数据
- **方案**: 
  1. 检查 `import_gateio.mjs` 脚本的错误日志
  2. Gate.io 跟单 API: `https://www.gate.io/copytrading/elite` 
  3. API endpoint: `https://www.gate.io/api/copytrade/copy_trading/lead_trader/list`
  4. 可能需要 Cloudflare bypass → 使用 Cloudflare Worker proxy (`proxy.ts` 已存在)
- **预期收益**: Gate.io 是 Top 10 交易所，可增加 200-500 交易员

#### Pionex（pionex）- 🔴 零数据
- **问题**: 导入脚本无数据产出
- **方案**:
  1. Pionex 的跟单/排行榜在 `https://www.pionex.com/copy-trading`
  2. API 可能需要逆向工程（Pionex 使用自定义 API）
  3. 已有 `import_pionex_v2.mjs` — 检查是否有更新的 API 端点
- **预期收益**: 增加 100-200 交易员

#### Kwenta（Synthetix）- 🔴 零数据
- **问题**: 链上 DEX，可能 API 变更
- **方案**:
  1. Kwenta 使用 Synthetix V3 on Optimism/Base
  2. 数据源: Synthetix subgraph 或 Kwenta 自有 API
  3. `https://kwenta.eth.limo/` → 排行榜数据
  4. 可通过 The Graph 查询 Synthetix 交易数据
- **预期收益**: 增加 100-300 DeFi 交易员

#### MUX Protocol - 🔴 零数据
- **问题**: 导入脚本无数据
- **方案**:
  1. MUX (已更名为 MUXLP) 在 Arbitrum 上
  2. 使用 subgraph API 获取交易数据
  3. 可能已停止运营/被合并 — 需确认项目状态
- **预期收益**: 低优先级，项目可能已不活跃

### 4.2 高优先级：修复极少数据平台

#### BingX - 🔴 仅 4 条
```
方案: 
1. BingX Copy Trading API: https://bingx.com/en/copy-trading/
2. 公开 API: https://open-api.bingx.com/openApi/
3. 检查 import_bingx.mjs 的请求逻辑
4. BingX 可能有 rate limiting — 调整请求间隔
预期: 增加 200-400 交易员
```

#### Blofin - 🔴 仅 10 条
```
方案:
1. Blofin Copy Trading: https://blofin.com/copy-trading
2. 可能被 Cloudflare 保护
3. 使用 Playwright headless browser 抓取
4. 或通过已有的 cloudflare-worker proxy
预期: 增加 50-100 交易员
```

#### Phemex - 🔴 仅 20 条
```
方案:
1. Phemex API connector 已存在但数据极少
2. 检查 connector 是否分页正确
3. Phemex Copy Trading: https://phemex.com/copy-trading
4. API: https://api.phemex.com 有公开端点
5. 需确认分页逻辑（可能只抓了第一页）
预期: 增加 100-200 交易员
```

#### Bitmart - 🔴 0 条（有 connector 无 cron）
```
方案:
1. connector 代码已存在于 connectors/bitmart/
2. 添加 cron 调度到 vercel.json
3. 创建 import_bitmart.mjs 脚本
4. BitMart Copy Trading API 已公开
预期: 增加 50-100 交易员
```

### 4.3 中优先级：字段覆盖率优化

#### trades_count (12.2% → 目标 60%+)
- **Binance/Bybit/OKX/HTX**: API 返回 tradeCount/totalOrder 字段，但未正确映射
  - 检查 normalize() 函数的字段映射
  - 确认 API 响应中是否包含此字段
- **GMX**: 已有 closedCount 从 Subsquid
- **方案**: 逐个平台审查 normalize() 映射，修复遗漏字段

#### max_drawdown (42.7% → 目标 70%+)
- **完全缺失的平台**: coinex, weex, phemex, gains, xt, bingx, lbank
  - CoinEx/Weex: 检查 API 是否提供 drawdown
  - 缺少原生 drawdown 的平台：可从 equity curve 计算
- **方案**: 
  1. 优先检查各平台 API 是否有 drawdown 字段
  2. 对有 equity_curve 数据的平台，离线计算 max_drawdown
  3. 需要新增 `compute_drawdown.mjs` 脚本

#### win_rate (56.3% → 目标 80%+)
- **mexc (7%)**: API 可能返回 winRate 但映射错误
- **coinex (25%)**: 同上
- **okx_web3 (0%)**: Web3 钱包不提供 win_rate — 需从交易历史计算
- **dydx (1%)**: 链上数据，需逐笔计算
- **方案**: 审查各平台 API 字段映射；DeFi 平台考虑离线计算

#### pnl (62.0% → 目标 85%+)
- **完全缺失**: xt, bingx, lbank, blofin, binance_web3
- **极低覆盖**: mexc(7%), bitget(7-8%)
- **方案**: 
  1. 检查这些平台 API 是否返回 PNL 但未映射
  2. Bitget: `profit` 字段映射可能失效
  3. MEXC: 可能需要 detail API 补充

### 4.4 字段映射修复清单

```typescript
// 需要审查的 connector normalize() 函数：
// 1. bitget_futures: pnl 仅 7% — 检查 'profit' 字段是否仍然存在
// 2. mexc: pnl/win_rate/max_dd 仅 7% — API 字段可能已变
// 3. coinex: pnl/win_rate 仅 25% — 需要 detail API
// 4. gains: ROI/PNL 仅 2% — 基本只存了 trades_count
// 5. dydx: win_rate/max_dd ≈ 0% — 链上数据限制
```

### 4.5 时间窗口字段（0% → 需架构决策）

所有 `pnl_7d`, `pnl_30d`, `win_rate_7d` 等字段均为空。

**根因**: 当前 snapshot 表按 `season_id` (7D/30D/90D) 分行存储，每个时间窗口是独立记录，不是同一行的不同列。

**方案**:
1. 这些列可能是用于聚合视图的——需确认前端是否需要
2. 如果需要，添加定期聚合任务：将同一交易员的 7D/30D 快照合并到这些列
3. 或者：在 API 层做实时聚合，不修改存储

### 4.6 需要 Playwright 爬虫的平台

以下平台无公开 API 或被 Cloudflare 保护：

| 平台 | 原因 | 方案 |
|------|------|------|
| Gate.io | Cloudflare 保护 | Playwright + Cloudflare Worker proxy |
| Blofin | Cloudflare 保护 | Playwright headless |
| LBank | 可能无公开 API | Playwright 抓取排行榜页面 |
| XT.com | 仅有 ROI | Playwright 补充 detail 数据 |

**已有基础设施**: 
- `cloudflare-worker/` 目录 — Cloudflare Worker 代理
- `proxy.ts` — 代理层
- `app/api/scrape/proxy/` — 代理抓取 API

---

## 5. 缺失的主流平台

### 5.1 应新增的数据源（按重要性排序）

| 优先级 | 平台 | 类型 | 日均交易量 | 跟单/排行功能 | 难度 | 预期交易员数 |
|--------|------|------|-----------|-------------|------|------------|
| 🔴 P0 | **Gate.io** | CEX | ~$1B+ | ✅ 有跟单 | 中（已有脚本） | 300-500 |
| 🔴 P0 | **BingX** | CEX | ~$500M+ | ✅ 有跟单 | 中（已有脚本） | 200-400 |
| 🟠 P1 | **Bitunix** | CEX | ~$2B+ | ✅ 有跟单 | 中 | 200-300 |
| 🟠 P1 | **Jupiter Perps** | DEX (Solana) | ~$500M+ | ✅ 有排行榜 | 中 | 500-1000 |
| 🟠 P1 | **Drift Protocol** | DEX (Solana) | ~$200M+ | ✅ 有排行榜 | 中 | 300-500 |
| 🟡 P2 | **Vertex Protocol** | DEX (Arbitrum) | ~$200M+ | ✅ 有排行榜 | 中 | 200-300 |
| 🟡 P2 | **ApeX Pro** | DEX (zkSync) | ~$100M+ | ✅ 有排行榜 | 低 | 100-200 |
| 🟡 P2 | **Aevo** | DEX | ~$100M+ | ✅ 有排行榜 | 低 | 100-200 |
| 🟡 P2 | **BTCC** | CEX | ~$500M+ | ✅ 有跟单 | 高 | 100-200 |
| 🟡 P2 | **CoinW** | CEX | ~$300M+ | ✅ 有跟单 | 高 | 100-200 |
| 🟢 P3 | **Toobit** | CEX | ~$1B+ | ✅ 有跟单 | 中 | 100-200 |
| 🟢 P3 | **Level Finance** | DEX (BNB Chain) | ~$50M+ | 有排行 | 中 | 50-100 |
| 🟢 P3 | **Synthetix/Kwenta** | DEX (Optimism) | ~$50M+ | 有排行 | 中（已有脚本） | 100-200 |
| 🟢 P3 | **Rabbitx** | DEX | ~$50M+ | 有排行 | 低 | 50-100 |
| ⬜ P4 | **Zeta Markets** | DEX (Solana) | ~$30M+ | 有排行 | 中 | 50-100 |
| ⬜ P4 | **Paradex** | DEX (Starknet) | ~$20M+ | 有排行 | 中 | 50-100 |

### 5.2 Solana DEX 缺口（严重）

当前项目 **完全没有 Solana 生态**的数据。这是 2025-2026 最活跃的链之一：
- **Jupiter Perps**: 最大的 Solana 永续合约 DEX
- **Drift Protocol**: Solana 上的老牌永续合约协议  
- **Zeta Markets**: Solana 上的期权+永续合约
- **Flash Trade**: Solana 上的新兴永续合约

**建议**: 创建 Solana connector 框架，优先接入 Jupiter 和 Drift。

---

## 6. 行动计划

### Phase 1: 紧急修复（1-2 周）

| # | 任务 | 预期影响 | 难度 |
|---|------|---------|------|
| 1 | 修复 Gate.io 导入脚本 | +300-500 交易员 | 中 |
| 2 | 修复 BingX 导入脚本 | +200-400 交易员 | 中 |
| 3 | 激活 BitMart connector（加 cron） | +50-100 交易员 | 低 |
| 4 | 修复 Phemex connector 分页 | +100-200 交易员 | 低 |
| 5 | 审查所有 normalize() 字段映射 | PNL/win_rate 覆盖率翻倍 | 中 |
| 6 | 修复 Kwenta/MUX 脚本（或移除无效 cron） | 清理或修复 | 低 |

### Phase 2: 字段补充（2-3 周）

| # | 任务 | 预期影响 | 难度 |
|---|------|---------|------|
| 7 | 创建 drawdown 离线计算脚本 | max_drawdown 42%→70% | 中 |
| 8 | 修复 Bitget PNL 映射 | +800 条 PNL 数据 | 低 |
| 9 | 修复 MEXC 字段覆盖 | +800 条 PNL/WR 数据 | 中 |
| 10 | 修复 CoinEx 字段覆盖 | +500 条 PNL/WR 数据 | 中 |
| 11 | 修复 Gains Network 数据映射 | +1200 条指标数据 | 中 |
| 12 | 增加 trades_count 映射 | 12%→50%+ | 中 |

### Phase 3: 新平台扩展（3-6 周）

| # | 任务 | 预期影响 | 难度 |
|---|------|---------|------|
| 13 | 新增 Jupiter Perps connector | +500-1000 Solana 交易员 | 高 |
| 14 | 新增 Drift Protocol connector | +300-500 Solana 交易员 | 高 |
| 15 | 新增 Bitunix connector | +200-300 交易员 | 中 |
| 16 | 新增 Vertex Protocol connector | +200-300 交易员 | 中 |
| 17 | 新增 ApeX Pro connector | +100-200 交易员 | 低 |
| 18 | 改善 Blofin/LBank (Playwright) | +150 交易员 | 高 |

### Phase 4: 架构优化（持续）

| # | 任务 | 预期影响 |
|---|------|---------|
| 19 | 完成 V2 表迁移（CeFi 平台写入 V2） | 架构统一 |
| 20 | 填充 trader_profiles_v2（0条→全覆盖） | Profile 数据完整 |
| 21 | traders 表与 snapshots 关联修复 | 数据完整性 |
| 22 | 时间窗口聚合（7d/30d 字段） | 排行榜维度丰富 |
| 23 | 去重机制优化 | 数据质量提升 |

---

## 7. 关键指标追踪

### 当前基线 vs 目标

| 指标 | 当前 | Phase 1 目标 | Phase 3 目标 |
|------|------|-------------|-------------|
| 总交易员数 | 7,318 | 8,500+ | 12,000+ |
| 活跃数据源 | 23 | 27+ | 32+ |
| ROI 覆盖率 | 86% | 90% | 95% |
| PNL 覆盖率 | 62% | 78% | 85% |
| Win Rate 覆盖率 | 56% | 72% | 80% |
| Max Drawdown 覆盖率 | 43% | 65% | 75% |
| Trades Count 覆盖率 | 12% | 45% | 60% |
| 零数据平台 | 5 | 0 | 0 |

---

*报告生成于 2026-01-30 by Data Analysis Agent*
