# Multi-Chain Asset Analysis Integration Plan

> Created: 2026-02-12 | Status: Research Complete

## 1. API Provider Comparison

| Provider | Free? | Rate Limit | Multi-Chain | Data Types |
|----------|-------|------------|-------------|------------|
| **DefiLlama** | ✅ 完全免费 | 无硬限制(建议<300/5min) | 200+链 | TVL, 协议数据, yields, stablecoins, volumes |
| **Zapper** | ❌ 付费 | 需申请 | ~15链 | Portfolio, DeFi positions, NFTs, tx history |
| **Zerion** | ⚠️ 有限免费 | 免费tier很小 | ~15链 | Portfolio, token balances, DeFi positions |
| **Alchemy** | ⚠️ 免费tier | 300M CU/月(免费) | 8链 | Token balances, NFTs, tx history, webhooks |
| **Moralis** | ⚠️ 免费tier | 40k CU/天(免费) | 13链 | Token balances, DeFi, tx history, price |
| **1inch** | ✅ 免费 | 适中 | 11链 | DEX aggregation, token prices, swap quotes |

### 详细分析

#### DefiLlama (🥇 首选 - Quick Win)
- **完全免费**, 无需API key
- 端点: `/v2/chains`, `/v2/protocols`, `/v2/historicalChainTvl/{chain}`, `/yields/pools`
- 数据: 链级TVL, 协议TVL/排名/分类, DeFi收益率, 稳定币数据, DEX交易量
- **局限**: 无钱包级别数据(token balances等)

#### Alchemy (🥈 钱包数据首选)
- 免费tier: 300M Compute Units/月, 足够中等规模
- 支持链: Ethereum, Polygon, Arbitrum, Optimism, Base, Solana, BNB(部分)
- 数据: `getTokenBalances`, `getAssetTransfers`, NFT APIs
- **付费**: Growth $49/月(1.5B CU), Scale自定义

#### Moralis (🥉 备选)
- 免费tier: 40,000 CU/天
- 强项: 统一API跨链查token balances + DeFi positions
- **付费**: Pro $49/月, Business $249/月

#### Zapper/Zerion
- 都转向付费模式, 免费tier极小或需申请
- 不推荐作为主要数据源

#### 1inch
- 免费, 主要用于价格查询和swap路由
- 可补充token价格数据

## 2. 目标链支持矩阵

| Chain | DefiLlama | Alchemy | Moralis | 1inch | 优先级 |
|-------|-----------|---------|---------|-------|--------|
| Ethereum | ✅ | ✅ | ✅ | ✅ | P0 |
| Solana | ✅ | ✅ | ✅ | ❌ | P0 |
| Base | ✅ | ✅ | ✅ | ✅ | P1 |
| Arbitrum | ✅ | ✅ | ✅ | ✅ | P1 |
| Polygon | ✅ | ✅ | ✅ | ✅ | P1 |
| BNB Chain | ✅ | ⚠️ | ✅ | ✅ | P2 |
| Avalanche | ✅ | ❌ | ✅ | ✅ | P2 |
| Optimism | ✅ | ✅ | ✅ | ✅ | P2 |

## 3. 数据能力总结

### 可获取数据

| 数据类型 | 免费来源 | 付费来源 |
|----------|----------|----------|
| 链级TVL & 趋势 | DefiLlama | - |
| 协议TVL/排名 | DefiLlama | - |
| DeFi收益率 | DefiLlama | - |
| DEX交易量 | DefiLlama | - |
| Token价格 | 1inch, DefiLlama | Moralis |
| 钱包Token余额 | Alchemy(免费tier) | Moralis Pro |
| 交易历史 | Alchemy(免费tier) | Moralis Pro |
| DeFi持仓明细 | - | Zapper, Zerion |
| 跨链Portfolio聚合 | - | Zerion, Moralis |

### 与现有Trader Profiles集成

现有 `trader_sources` + `trader_snapshots` 表存储交易员排名/ROI/PnL数据(来自CEX)。

多链数据集成方式:
1. **chain_analytics表**: 存储链级TVL/协议数据(DefiLlama), 作为市场背景指标
2. **trader_chain_activity表**(Phase 2): 如果有trader钱包地址, 可追踪on-chain活动
3. **Dashboard增强**: 在trader profile旁显示其活跃链的TVL/生态数据

## 4. Implementation Roadmap

### Phase 1: DefiLlama集成 (1-2天) ✅ Quick Win
- [x] 创建 `chain_analytics` 表(migration)
- [x] 创建 fetch脚本: 抓取8条链的TVL + top协议
- [ ] 设置cron: 每6小时更新一次
- 成本: **$0**

### Phase 2: Alchemy钱包数据 (3-5天)
- 注册Alchemy免费tier
- 实现 `getTokenBalances` for trader wallets
- 创建 `trader_wallet_balances` 表
- 成本: **$0** (免费tier内)

### Phase 3: 价格 + 收益率 (2-3天)
- DefiLlama yields API 集成
- 1inch 价格补充
- 成本: **$0**

### Phase 4: 全链Portfolio (需付费)
- Moralis Pro 或 Alchemy Growth
- 完整DeFi持仓追踪
- 成本: **$49-249/月**

## 5. Cost Estimates

| Phase | 月成本 | 备注 |
|-------|--------|------|
| Phase 1-3 | $0 | 全部免费API |
| Phase 4 (Alchemy Growth) | $49/月 | 1.5B CU, 足够大规模 |
| Phase 4 (Moralis Pro) | $49/月 | 更好的DeFi持仓数据 |
| 全功能 | ~$100/月 | Alchemy + Moralis |

## 6. 推荐策略

**先免费后付费**: DefiLlama(链数据) + Alchemy免费tier(钱包数据) + 1inch(价格) 可覆盖80%需求, 成本$0。等用户量增长后再升级付费tier。
