# Ranking Arena 排行榜系统优化评估报告

> 评估日期: 2026-02-02
> 项目路径: /Users/adelinewen/ranking-arena

---

## 目录

1. [数据稳定性评估](#1-数据稳定性评估)
2. [数据全面性评估](#2-数据全面性评估)
3. [用户体验评估](#3-用户体验评估)
4. [优化方向建议](#4-优化方向建议)
5. [优先级矩阵](#5-优先级矩阵)

---

## 1. 数据稳定性评估

### 1.1 各平台数据刷新可靠性

#### ✅ 稳定平台 (7个) — 纯 API，无反爬

| 平台 | 数据源 | 可靠性 | 备注 |
|------|--------|--------|------|
| OKX Futures | 公开 API | ⭐⭐⭐⭐⭐ | 直接 API 调用，无限制 |
| HTX (火币) | 公开 API | ⭐⭐⭐⭐⭐ | 稳定运行 |
| Gains Network | GraphQL | ⭐⭐⭐⭐⭐ | Arbitrum 链上数据 |
| Hyperliquid | L1 API | ⭐⭐⭐⭐⭐ | stats-data.hyperliquid.xyz |
| GMX | Subgraph | ⭐⭐⭐⭐⭐ | gmx.squids.live GraphQL |
| dYdX | Chain API | ⭐⭐⭐⭐ | indexer 可用时稳定 |
| Kwenta/MUX | Subgraph | ⭐⭐⭐⭐ | 数据量较小 |

#### 🟡 需代理平台 (2个) — 需要 ClashX 代理节点

| 平台 | 数据源 | 可靠性 | 备注 |
|------|--------|--------|------|
| Binance Futures | API via 代理 | ⭐⭐⭐⭐ | 需 SG/JP/HK 节点，美国 IP 被封 |
| Binance Spot | API via 代理 | ⭐⭐⭐⭐ | 同上 |

#### 🟠 需浏览器平台 (6个) — 需要 Real Chrome + 代理

| 平台 | 数据源 | 可靠性 | 问题 |
|------|--------|--------|------|
| MEXC | 浏览器拦截 | ⭐⭐⭐ | Cloudflare JS challenge |
| KuCoin | 浏览器拦截 | ⭐⭐⭐ | API 端点变更，需 Real Chrome |
| CoinEx | 浏览器拦截 | ⭐⭐⭐ | CF 防护 |
| XT | 浏览器拦截 | ⭐⭐ | 只能抓到 top 3 per category |
| Weex | 浏览器拦截 | ⭐⭐⭐ | 数据量小 |
| Phemex | 浏览器拦截 | ⭐⭐⭐ | 数据量小 |

#### ❌ 不稳定/失效平台 (5个)

| 平台 | 问题 | 当前状态 |
|------|------|----------|
| Bybit | WAF 严格封锁，API 空响应 | 🔴 只有 23-133 条旧数据 |
| Bitget | 跟单 API 需登录 token | 🔴 218 条，部分过期 |
| BingX | SSR/WebSocket，无法拦截 JSON | 🔴 只有 4 条 |
| BloFin | 同 BingX | 🔴 数据极少 |
| LBank | 30D 无数据 | 🔴 0 条有效数据 |

### 1.2 Cron Job 成功率和失败模式

#### 问题发现 (2026-02-01)
- **15/24 平台数据过期**，部分超过 7-8 天未更新
- **根本原因**: Vercel Cron 执行 `child_process.exec` 跑 `scripts/` 在 serverless 环境中文件不存在

#### 当前架构: Inline Fetchers

已实现 **30 个** inline fetcher 在 `lib/cron/fetchers/`:
```
binance-futures.ts, binance-spot.ts, binance-web3.ts,
bybit.ts, bybit-spot.ts, bitget-futures.ts, bitget-spot.ts,
okx-futures.ts, okx-web3.ts, htx.ts, mexc.ts, kucoin.ts,
coinex.ts, weex.ts, phemex.ts, lbank.ts, blofin.ts,
xt.ts, pionex.ts, bingx.ts, gateio.ts,
gmx.ts, hyperliquid.ts, gains.ts, kwenta.ts, mux.ts,
vertex.ts, drift.ts, jupiter-perps.ts, aevo.ts, synthetix.ts
```

#### Cron 配置 (vercel.json)
- **38 个定时任务**配置
- 每 4 小时刷新主要平台
- 熔断器机制: 3 次失败后熔断，5 分钟后尝试恢复

### 1.3 数据延迟情况

| 数据类型 | 更新频率 | 实际延迟 |
|----------|----------|----------|
| API 平台数据 | 每 4 小时 | 0-4 小时 |
| 浏览器平台数据 | 需手动/本地 cron | 4-24 小时+ |
| 交易员详情 | 每 2 小时 | 0-2 小时 |
| 热度分数 | 每 5 分钟 | < 5 分钟 |

### 1.4 异常数据处理机制

**已实现:**
- ROI 异常阈值: > 10000% 被过滤
- Arena Score 计算: ROI/DD/WR 综合评分
- 熔断器: 连续失败自动断开
- 数据校验: 必须有至少一个指标 (ROI/PnL/WR/DD) 才入库

**缺失:**
- 没有数据新鲜度自动告警
- 没有异常值自动标记和人工审核流程
- 没有历史数据比对验证

---

## 2. 数据全面性评估

### 2.1 各平台覆盖率

#### 当前数据状态 (season_id='30D', 2026-02-01)

| 平台 | 数量 | 有 Score | ROI 覆盖 | 状态 |
|------|------|----------|----------|------|
| GMX | 672 | 100% | ✅ | ✅ 正常 |
| Binance Futures | 659 | 95% | ✅ | ✅ 正常 |
| Gains | 657 | 100% | ✅ | ✅ 正常 |
| Hyperliquid | 531 | 97% | ✅ | ✅ 正常 |
| HTX | 483 | 100% | ✅ | ✅ 正常 |
| OKX | 282 | 100% | ✅ | ✅ 正常 |
| Bitget Futures | 218 | 100% | ✅ | ⚠️ 略过期 |
| CoinEx | 171 | 100% | ✅ | ✅ 正常 |
| MEXC | 147 | 100% | ✅ | ✅ 正常 |
| KuCoin | 140 | 100% | ✅ | ✅ 正常 |
| Bybit | 133 | 100% | ✅ | 🔴 过期 |
| Binance Spot | 130 | 100% | ✅ | ✅ 正常 |
| dYdX | 83 | 100% | ✅ | ✅ 正常 |
| Bitget Spot | 60 | **50%** | ⚠️ 半缺失 | ⚠️ 问题 |
| Weex | 32 | 100% | ✅ | ✅ 正常 |
| Phemex | 10 | 100% | ✅ | ⚠️ 数据少 |
| XT | 9 | 100% | ✅ | ⚠️ 数据少 |
| BingX | 4 | 100% | ✅ | 🔴 数据极少 |
| LBank | 0 | — | — | 🔴 无数据 |
| **总计** | **4421** | **~98%** | | |

### 2.2 字段完整性

| 字段 | 覆盖率 | 问题平台 |
|------|--------|----------|
| ROI | ~85% | Bitget Spot (50%), 部分链上协议 |
| Win Rate | ~78% | Hyperliquid (缺 211), GMX (缺 85) |
| Max Drawdown | ~82% | Hyperliquid, 部分 DEX |
| PnL | ~90% | 大部分平台有 |
| Arena Score | ~98% | 只要有 ROI 就能计算 |

### 2.3 数据量分布

```
大平台 (>500):  GMX(672), Binance Futures(659), Gains(657), Hyperliquid(531)
中平台 (100-500): HTX(483), OKX(282), Bitget(218), CoinEx(171), MEXC(147)
                  KuCoin(140), Bybit(133), Binance Spot(130), dYdX(83)
小平台 (<100):    Bitget Spot(60), Weex(32), Phemex(10), XT(9), BingX(4), LBank(0)
```

### 2.4 缺失数据的根本原因分析

| 原因 | 影响平台 | 解决难度 |
|------|----------|----------|
| **API 限制** | XT (只返回 top 3/category) | 🔴 高 |
| **反爬机制 (CF)** | Bitget, KuCoin, CoinEx, MEXC | 🟡 中 (Real Chrome 可解) |
| **地区封锁** | dYdX indexer, Binance (美国 IP) | 🟡 中 (代理可解) |
| **WAF 严格封锁** | Bybit | 🔴 高 |
| **SSR/WebSocket** | BingX, BloFin | 🔴 高 |
| **需登录 Token** | Bitget 跟单 API | 🟠 中 |
| **字段名不一致** | 各平台 API 差异 | 🟢 低 |
| **平台数据少** | Phemex, Weex, LBank | — (非技术问题) |

---

## 3. 用户体验评估

### 3.1 当前 UI 的痛点

#### 已修复 (2026-02-01~02):
- ✅ Avatar 400 错误 (next/image 优化失败)
- ✅ 7 个 i18n 缺失 key
- ✅ PnL Score 标签硬编码
- ✅ DEX 平台被错误分类为 "Futures"
- ✅ also_on 显示原始名称 (htx → HTX)

#### 待解决:
| 问题 | 严重程度 | 影响范围 |
|------|----------|----------|
| 数据新鲜度不明确 | 🟡 中 | 用户无法知道数据是否过期 |
| 筛选条件无持久化 | 🟢 低 | 页面刷新后筛选丢失 |
| 排行榜加载慢时无进度反馈 | 🟡 中 | 首次加载体验差 |
| 移动端表格横向滚动体验 | 🟡 中 | 小屏设备阅读困难 |
| 无数据时提示不友好 | 🟢 低 | 空状态显示 "N/A" |

### 3.2 筛选/搜索功能评估

**已实现:**
- ✅ 时间范围选择器 (7D/30D/90D)
- ✅ 交易所筛选 (ExchangeFilter)
- ✅ 分类筛选 (Futures/Spot/On-chain)
- ✅ 预设筛选 (FilterPresets: Top Performers, Low Risk 等)
- ✅ 高级筛选 (Pro 功能: ROI 范围, 回撤范围等)
- ✅ 搜索 (RankingSearch: 实时建议, 键盘导航)
- ✅ URL 参数同步 (筛选状态可分享)

**缺失:**
- ❌ 保存自定义筛选组合
- ❌ 多维度组合筛选 (AND/OR 逻辑)
- ❌ 搜索历史记录
- ❌ 交易员对比功能快捷入口

### 3.3 数据展示清晰度

| 方面 | 评分 | 备注 |
|------|------|------|
| Arena Score 展示 | ⭐⭐⭐⭐⭐ | 有分数分解 Tooltip, 置信度指示器 |
| ROI 展示 | ⭐⭐⭐⭐ | 带 % 符号, 正负颜色区分 |
| Rank 变化 | ⭐⭐⭐ | 显示 NEW 或 ↑↓ 数字 |
| 平台来源 | ⭐⭐⭐⭐ | 显示交易所图标和名称 |
| 缺失数据 | ⭐⭐⭐⭐ | 显示 "N/A" + tooltip 说明 |

### 3.4 移动端体验

**已实现:**
- ✅ 响应式布局 (Tailwind 断点)
- ✅ 底部导航栏 (MobileBottomNav)
- ✅ 触摸友好的按钮尺寸
- ✅ 下拉刷新组件 (PullToRefresh)
- ✅ Capacitor 原生应用支持

**问题:**
- 🟡 表格在手机上需要横向滚动
- 🟡 筛选器抽屉式交互可改进
- 🟢 图表全屏模式缺失

### 3.5 加载性能

| 指标 | 目标 | 当前估计 |
|------|------|----------|
| 首页 LCP | < 1.5s | ~2s (CDN 缓存命中时 < 1s) |
| FID | < 50ms | ~40ms |
| CLS | < 0.1 | ~0.05 |
| API P95 | < 200ms | ~150ms (缓存命中) |

**优化点:**
- 使用 `dynamic` 延迟加载重组件 (AdvancedFilter, ShareTop10Button)
- SWR 缓存 + Vercel CDN
- 骨架屏加载 (RankingTableSkeleton)

---

## 4. 优化方向建议

### 4.1 短期改进 (1-2 周)

#### P0 - 紧急

| 任务 | 描述 | 工作量 |
|------|------|--------|
| **修复 Bybit 抓取** | 研究新的 API 端点或浏览器自动化方案 | 2-3 天 |
| **Bitget Auth Token** | 实现登录态维护机制 | 1-2 天 |
| **数据新鲜度告警** | 自动检测并通知过期平台 | 1 天 |
| **本地 Cron 备份** | Mac 本地 cron 作为 Vercel Cron 的备份 | 0.5 天 |

#### P1 - 重要

| 任务 | 描述 | 工作量 |
|------|------|--------|
| **字段映射完善** | 统一各平台 ROI/WR/DD 字段提取 | 1-2 天 |
| **数据新鲜度指示器** | 前端显示数据最后更新时间 | 0.5 天 |
| **重试机制优化** | 失败平台自动重试 + 指数退避 | 1 天 |
| **XT 分页抓取** | 研究获取更多数据的方法 | 1 天 |

### 4.2 中期规划 (1-2 个月)

#### 架构改进

| 任务 | 描述 | 收益 |
|------|------|------|
| **独立 Worker 服务** | 将抓取任务迁出 Vercel，用独立服务器/Docker | 稳定性 ⬆️ 成功率 ⬆️ |
| **代理池管理** | 多地区代理轮换，自动切换失效节点 | 可靠性 ⬆️ |
| **数据质量评分** | 为每条数据计算质量分，权重纳入排名 | 准确性 ⬆️ |
| **Redis 缓存分层** | 热数据 → Redis, 冷数据 → CDN | 性能 ⬆️ |

#### 功能扩展

| 任务 | 描述 | 用户价值 |
|------|------|----------|
| **更多 DeFi 协议** | Vertex, Drift, Jupiter Perps, Aevo, Synthetix | 覆盖面 ⬆️ |
| **历史数据图表** | 交易员 ROI 历史趋势 | 分析深度 ⬆️ |
| **自定义筛选保存** | 用户可保存筛选组合 | 便捷性 ⬆️ |
| **批量关注/对比** | 一键对比多个交易员 | 效率 ⬆️ |

### 4.3 长期方向 (架构层面)

#### 数据管道重构

```
当前架构:
  Vercel Cron → API Route → child_process/inline fetcher → Supabase

目标架构:
  ┌─────────────────────────────────────────────────────────────┐
  │                    Scheduler (独立服务)                      │
  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
  │  │ API Job │  │Browser  │  │ Chain   │  │ Dune    │        │
  │  │ Worker  │  │ Worker  │  │ Worker  │  │ Worker  │        │
  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘        │
  └───────┼───────────┼───────────┼───────────┼────────────────┘
          │           │           │           │
          v           v           v           v
  ┌─────────────────────────────────────────────────────────────┐
  │                    Data Pipeline (Kafka/Redis Stream)       │
  └─────────────────────────────────────────────────────────────┘
          │
          v
  ┌─────────────────────────────────────────────────────────────┐
  │                    ETL Service                               │
  │  • 数据清洗、标准化                                           │
  │  • 异常检测、质量评分                                         │
  │  • Arena Score 计算                                          │
  └─────────────────────────────────────────────────────────────┘
          │
          v
  ┌─────────────────────────────────────────────────────────────┐
  │                    Storage Layer                             │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
  │  │ Supabase │  │ Redis    │  │ ClickHouse│ (历史数据)       │
  │  │ (主存储) │  │ (热缓存) │  │ (分析)   │                   │
  │  └──────────┘  └──────────┘  └──────────┘                   │
  └─────────────────────────────────────────────────────────────┘
```

#### 实时数据推送

| 阶段 | 内容 |
|------|------|
| Phase 1 | Supabase Realtime 订阅排行榜变化 |
| Phase 2 | WebSocket 推送交易员实时状态 |
| Phase 3 | 链上事件监听 (on-chain protocols) |

#### 数据聚合服务分离

- 将数据抓取和聚合逻辑从 Next.js 应用完全分离
- 使用独立的数据服务，支持水平扩展
- 前端应用只消费 API，不参与数据采集

---

## 5. 优先级矩阵

### 影响 vs 工作量矩阵

```
        高影响
           │
   ┌───────┼───────┐
   │ 修复  │ 独立  │
   │ Bybit │ Worker│
   │       │ 服务  │
   ├───────┼───────┤ 低工作量 ──────────────────── 高工作量
   │ 数据  │ 代理  │
   │新鲜度 │ 池管理│
   │ 告警  │       │
   └───────┼───────┘
           │
        低影响
```

### 推荐执行顺序

```
Week 1:
├── [P0] 数据新鲜度告警机制
├── [P0] 本地 Cron 备份方案
└── [P1] 字段映射完善 (解决 WR/DD 缺失)

Week 2:
├── [P0] Bybit 抓取方案研究与实现
├── [P0] Bitget Auth Token 机制
└── [P1] 数据新鲜度前端指示器

Month 1:
├── 独立 Worker 服务 MVP
├── 代理池管理基础版
└── 更多 DeFi 协议接入 (Vertex, Drift)

Month 2:
├── 数据质量评分系统
├── Redis 缓存分层优化
├── 历史数据图表功能
└── 自定义筛选保存功能
```

---

## 附录

### A. 平台 API 参考

| 平台 | API 端点 | 认证要求 | 限流 |
|------|----------|----------|------|
| OKX Futures | /api/v5/copytrading/public-lead-traders | 无 | 20/2s |
| HTX | /v2/copy/public/top-traders | 无 | 10/s |
| Binance | /bapi/futures/v1/friendly/future/copy-trade/ | 无 (需代理) | 10/s |
| Hyperliquid | stats-data.hyperliquid.xyz/Mainnet/leaderboard | 无 | 无限制 |
| GMX | gmx.squids.live/gmx-synthetics-arbitrum:prod | 无 | GraphQL |
| Gains | backend-subgraph gateway | 无 | GraphQL |

### B. 已知问题 Tracker

| ID | 平台 | 问题 | 状态 | 优先级 |
|----|------|------|------|--------|
| #1 | Bybit | WAF 完全封锁 | 🔴 未解决 | P0 |
| #2 | Bitget | 需登录 Token | 🟡 需研究 | P0 |
| #3 | BingX | SSR 无法拦截 | 🔴 未解决 | P2 |
| #4 | BloFin | WebSocket 数据 | 🔴 未解决 | P2 |
| #5 | XT | 只有 9 条数据 | 🟡 API 限制 | P1 |
| #6 | LBank | 30D 无数据 | 🔴 未解决 | P2 |

### C. Cron 任务健康度

截至 2026-02-02:
- ✅ 正常运行: 约 20/38 任务
- ⚠️ 偶尔失败: 约 10/38 任务
- ❌ 持续失败: 约 8/38 任务 (主要是 Bybit/BingX/BloFin 等)

---

*报告生成时间: 2026-02-02*
*下次评估建议时间: 2026-02-16*
