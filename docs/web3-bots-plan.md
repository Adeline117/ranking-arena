# Web3 机器人排行榜方案

## 一、什么是 Web3 机器人

在排行榜中加入的"Web3机器人"包含三大类：

### 1. Telegram Trading Bots（TG交易机器人）
最成熟、用户量最大的赛道
- **Banana Gun** — Solana/ETH链最大的Sniper Bot，月交易量$10B+
- **Trojan Bot** — Solana第二大TG Bot
- **Maestro** — 多链TG Bot（ETH/BSC/Solana）
- **BONKbot** — Solana Memecoin专用
- **Unibot** — ETH链先驱（有代币UNIBOT）
- **Sol Trading Bot** — Solana快速交易

### 2. AI Trading Agents（AI交易代理）
最前沿、增长最快的赛道
- **ai16z / ElizaOS** — 开源AI Agent框架，做交易+社交
- **Virtuals Protocol** — Base链AI Agent生态，每个Agent是独立代币
- **AIXBT** — AI驱动的crypto市场分析Agent
- **Griffain** — Solana链AI Agent，可执行交易
- **Spectral** — 链上AI推理，交易信号

### 3. On-chain Vaults & Strategies（链上金库/策略）
自动化策略，类似量化基金
- **Hyperliquid Vaults** — 自动交易策略金库
- **Drift Vaults** — Solana永续合约策略
- **Yearn Finance** — 自动收益策略
- **Beefy Finance** — 多链自动复利

## 二、数据来源方案

### 可直接获取（有API）

| 来源 | 数据类型 | API | 可行性 |
|------|----------|-----|--------|
| Hyperliquid Vaults | 收益率/TVL/历史 | `api.hyperliquid.xyz` POST vaultSummaries | ✅ 有API但需vault地址 |
| Birdeye | Solana钱包PnL | `public-api.birdeye.so` | ✅ 免费tier |
| DeFi Llama | TVL/收益率 | `yields.llama.fi/pools` | ✅ 免费 |
| TheGraph | DEX交易历史 | GraphQL | ✅ 免费tier |
| Dune Analytics | 链上分析 | REST API | ⚠️ 需付费key |
| Cookie.fun | AI Agent排名 | REST API | ⚠️ 需API key |
| Arkham | 钱包标签/追踪 | REST API | ⚠️ 需API key |

### 需要链上直接读取

| 方法 | 数据 | 技术 |
|------|------|------|
| RPC扫链 | 钱包交易历史 | Solana/ETH RPC + 历史解析 |
| Event Log解析 | DEX交易记录 | 读取Swap事件日志 |
| 合约状态 | Vault TVL/份额 | 直接读合约 |

### 需要爬虫

| 来源 | 数据 | 方法 |
|------|------|------|
| Banana Gun排行榜 | Top traders PnL | 浏览器爬取（CF保护） |
| GMGN.ai | Smart money ranking | 浏览器爬取（CF保护） |
| Cielo Finance | Wallet PnL tracker | 浏览器爬取 |
| Nansen | Smart money labels | 需订阅 |

## 三、DB Schema扩展

```sql
-- 新增机器人/代理源表
CREATE TABLE bot_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- 机器人名称
  category TEXT NOT NULL,                -- 'tg_bot' | 'ai_agent' | 'vault' | 'strategy'
  chain TEXT,                            -- 'solana' | 'ethereum' | 'base' | 'arbitrum' | 'multi'
  contract_address TEXT,                 -- 合约地址（如有）
  token_address TEXT,                    -- 代币地址（如有）
  token_symbol TEXT,                     -- 代币符号
  website_url TEXT,
  twitter_handle TEXT,
  telegram_url TEXT,
  logo_url TEXT,
  description TEXT,
  launch_date DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 机器人性能快照
CREATE TABLE bot_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID REFERENCES bot_sources(id),
  season_id TEXT NOT NULL,               -- '7D' | '30D' | '90D'
  -- 交易性能
  total_volume NUMERIC,                  -- 交易量(USD)
  total_trades INTEGER,
  unique_users INTEGER,                  -- 使用人数
  revenue NUMERIC,                       -- 手续费收入
  -- 收益指标（针对vault/strategy）
  tvl NUMERIC,                           -- 总锁仓量
  apy NUMERIC,                           -- 年化收益率
  roi NUMERIC,                           -- 期间收益率
  max_drawdown NUMERIC,
  sharpe_ratio NUMERIC,
  -- 代币指标（针对有代币的）
  token_price NUMERIC,
  market_cap NUMERIC,
  token_holders INTEGER,
  -- 社交指标
  mindshare_score NUMERIC,               -- AI Agent影响力分
  twitter_followers INTEGER,
  telegram_members INTEGER,
  -- 评分
  arena_score NUMERIC,
  captured_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(bot_id, season_id)
);

-- 机器人历史收益曲线
CREATE TABLE bot_equity_curve (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID REFERENCES bot_sources(id),
  period TEXT NOT NULL,                  -- '7D' | '30D' | '90D'
  timestamp TIMESTAMPTZ NOT NULL,
  value NUMERIC NOT NULL,               -- 净值/收益率
  tvl NUMERIC,
  UNIQUE(bot_id, period, timestamp)
);

CREATE INDEX idx_bot_snapshots_season ON bot_snapshots(season_id, arena_score DESC);
CREATE INDEX idx_bot_sources_category ON bot_sources(category);
```

## 四、Arena Score 计算（机器人版）

```
Bot Arena Score = w1 * Volume Score
               + w2 * Performance Score  
               + w3 * Risk Score
               + w4 * Adoption Score
               + w5 * Longevity Score

其中:
- Volume Score (25%): 交易量排名百分位
- Performance Score (30%): ROI/APY排名百分位
- Risk Score (20%): 回撤控制 + Sharpe
- Adoption Score (15%): 用户数 + TVL
- Longevity Score (10%): 运营时间 + 稳定性
```

## 五、前端展示方案

### 排行榜新增Tab
```
排行榜: [全部] [交易员] [机器人] [AI Agent]
```

### 机器人卡片显示
- 名称 + Logo + 链标识
- 类别标签（TG Bot / AI Agent / Vault）
- 核心指标：交易量 | 用户数 | ROI | TVL
- Arena Score（0-100）

### 机器人详情页
- Performance：收益曲线、ROI、APY
- Statistics：交易量、用户数、手续费收入
- On-chain：合约地址、链上验证、代币信息
- Social：Twitter/Telegram/社区数据
- Risk：回撤、Sharpe、运营历史

## 六、Phase 1 实施计划（2周）

### Week 1: 基础架构 + 数据抓取
1. **DB建表** — bot_sources, bot_snapshots, bot_equity_curve
2. **手动录入Top 30机器人** — Banana Gun, Trojan, Maestro, ai16z, AIXBT, Virtuals等
3. **DeFi Llama集成** — 获取vault TVL/APY数据
4. **CoinGecko集成** — 获取机器人代币价格/市值
5. **Birdeye集成** — Solana机器人钱包PnL追踪

### Week 2: 前端 + 评分
6. **排行榜Tab** — 新增"机器人"分类
7. **机器人卡片** — 展示核心指标
8. **Arena Score v2** — 机器人专用评分公式
9. **机器人详情页** — 完整数据展示
10. **定时更新cron** — 每2小时刷新数据

### 未来扩展
- Phase 2: AI Agent深度追踪（on-chain交易分析）
- Phase 3: 用户创建自定义机器人组合
- Phase 4: 机器人 vs 人类交易员对比排行

## 七、预估成本
- Birdeye API: 免费tier（100 req/min）
- DeFi Llama: 免费
- CoinGecko: 免费tier（10K req/month）
- Dune Analytics: $349/month（可选，Phase 2）
- Cookie.fun: 待确认价格

**Phase 1 成本: $0**（全用免费API）
