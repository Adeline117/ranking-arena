# Arena Pipeline 架构诊断报告

**诊断日期**: 2026-03-13  
**诊断人**: 小昭 (Subagent)  
**项目路径**: /Users/adelinewen/ranking-arena

---

## 1. 当前架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    数据采集层 (Fetch Layer)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐         ┌─────────────────────┐          │
│  │ Cloudflare Cron  │────────▶│ batch-fetch-traders │          │
│  │  (每3-6小时)      │         │  (Vercel Edge)      │          │
│  └──────────────────┘         └─────────┬───────────┘          │
│                                          │                      │
│                           ┌──────────────┴──────────────┐       │
│                           │                             │       │
│              ┌────────────▼──────────┐    ┌─────────────▼─────┐ │
│              │ unified-connector     │    │ legacy fetchers   │ │
│              │ (26平台注册)          │    │ (6个仍在使用)     │ │
│              │ - PLATFORM_CONNECTORS │    │ binance-futures   │ │
│              │ - UnifiedConnector    │    │ binance-spot      │ │
│              │ - ConnectorRunner     │    │ okx-futures       │ │
│              └───────────┬───────────┘    │ gmx               │ │
│                          │                │ hyperliquid       │ │
│                          │                │ dydx              │ │
│                          │                └───────┬───────────┘ │
│                          │                        │             │
│              ┌───────────▼────────────────────────▼───────────┐ │
│              │         INLINE_FETCHERS (index.ts)            │ │
│              │  - fetchBinanceFutures()                      │ │
│              │  - fetchHyperliquid()                         │ │
│              │  - fetchGmx()                                 │ │
│              │  - ... (24个实际fetcher)                      │ │
│              └────────────────┬──────────────────────────────┘ │
│                               │                                │
│                    ┌──────────▼──────────┐                     │
│                    │  Platform APIs      │                     │
│                    │  - Binance API      │                     │
│                    │  - OKX API          │                     │
│                    │  - GraphQL (GMX)    │                     │
│                    │  - VPS Proxy (geo)  │                     │
│                    └──────────┬──────────┘                     │
└───────────────────────────────┼────────────────────────────────┘
                                │
              ┌─────────────────▼──────────────────┐
              │        Supabase Database           │
              │  - trader_snapshots (leaderboard)  │
              │  - trader_profiles_v2              │
              │  - trader_sources                  │
              └─────────────┬──────────────────────┘
                            │
┌───────────────────────────┼────────────────────────────────────┐
│                    数据增强层 (Enrichment Layer)                │
├───────────────────────────┼────────────────────────────────────┤
│                           │                                    │
│  ┌────────────────┐  ┌────▼──────────────┐                    │
│  │ Vercel Cron    │─▶│ batch-enrich      │                    │
│  │ (每天运行)      │  │ (Lambda 600s)     │                    │
│  └────────────────┘  └────┬──────────────┘                    │
│                           │                                    │
│              ┌────────────▼────────────────┐                   │
│              │  enrichment-runner.ts       │                   │
│              │  - runEnrichment()          │                   │
│              │  - 按平台并发限制 (2-15)     │                   │
│              │  - 每trader延迟 (200-2000ms)│                   │
│              │  - per-trader 15s timeout   │                   │
│              └────────────┬────────────────┘                   │
│                           │                                    │
│              ┌────────────▼────────────────┐                   │
│              │  17个 enrichment-*.ts       │                   │
│              │  - enrichment-binance.ts    │                   │
│              │  - enrichment-okx.ts        │                   │
│              │  - enrichment-dex.ts        │                   │
│              │  - enrichment-onchain.ts    │                   │
│              │  - enrichment-copin.ts      │                   │
│              │  - ... (分散的enrichment逻辑)│                   │
│              └────────────┬────────────────┘                   │
│                           │                                    │
│              ┌────────────▼────────────────┐                   │
│              │  平台API调用 (串行)          │                   │
│              │  - fetchEquityCurve()       │                   │
│              │  - fetchPositionHistory()   │                   │
│              │  - fetchStatsDetail()       │                   │
│              │  - Retry机制 (3次重试)      │                   │
│              └────────────┬────────────────┘                   │
│                           │                                    │
│              ┌────────────▼────────────────┐                   │
│              │  enrichment-db.ts           │                   │
│              │  - DELETE existing + INSERT │                   │
│              │  - 多次数据库写入            │                   │
│              └────────────┬────────────────┘                   │
└───────────────────────────┼────────────────────────────────────┘
                            │
              ┌─────────────▼──────────────────┐
              │        Supabase Database       │
              │  - trader_equity_curve         │
              │  - trader_position_history     │
              │  - trader_stats_detail         │
              │  - trader_asset_breakdown      │
              └────────────────────────────────┘
```

---

## 2. 核心瓶颈（按严重程度排序）

### 🔴 P0: Cloudflare Workers 120秒硬超时（无法绕过）

**问题描述**:
- Cloudflare Workers有**120秒硬超时限制**，无法通过任何配置绕过
- batch-fetch-traders运行在Cloudflare Workers上，超时会直接杀死进程
- 大平台（如binance_futures, hyperliquid）单个平台fetch就需要100-120秒
- 超时时丢失所有数据，无partial success

**影响范围**:
- 所有在Cloudflare Workers上运行的fetch任务
- 特别影响：binance_futures (120s), gmx (110s), mexc (141s)

**根本原因**:
1. 平台API分页慢（每页500ms延迟）
2. 需要fetch 500-1000个trader（多页）
3. 地理位置阻塞需要VPS代理（增加2-3s/页）
4. Enrichment被包含在fetch阶段（已在2026-03-12禁用，但代码仍存在）

**证据**:
```typescript
// batch-fetch-traders/route.ts
export const maxDuration = 600 // Vercel Pro max: 10 minutes (was 300s = 5min)

// 但实际部署在Cloudflare Workers时，硬超时是120s
// batch-fetch-traders-a: binance_futures + binance_spot = ~240s理论需求 → 120s实际限制
```

---

### 🔴 P0: batch-enrich 600秒超时（Lambda限制）

**问题描述**:
- batch-enrich运行在Vercel Lambda上，**maxDuration=600秒**（已从300s升级）
- 需要enrichment 12个平台 × 3个周期 = 36个任务
- 仍然频繁触发600s timeout，导致部分平台未完成enrichment

**当前缓解措施**（2026-03-13紧急修复）:
```typescript
// EMERGENCY REDUCTION (2026-03-13)
// Onchain platforms reduced from 150/120/100 to 50/40/30
hyperliquid: { limit90: 50, limit30: 40, limit7: 30 }  // 原150/120/100
gmx: { limit90: 50, limit30: 40, limit7: 30 }          // 原150/120/100
dydx: { limit90: 50, limit30: 40, limit7: 30 }         // 原150/120/100

// Per-platform timeout也缩减：
ONCHAIN_TIMEOUT_MS = 180_000  // 原360s
ENRICH_TIMEOUT_MS = 120_000   // 原240s
```

**为什么超时**:
1. **Onchain平台慢**: GraphQL查询延迟高（gmx, hyperliquid）
2. **API rate limiting**: 需要串行请求+延迟（每trader 1-2秒）
3. **per-trader timeout触发**: 15s timeout × 失败重试 = 浪费大量时间
4. **数据库写入慢**: 每个trader 3-5次DELETE+INSERT操作

**影响**:
- 用户看到的equity curve数据不完整（只enriched前50个trader）
- 高ROI trader可能没有enrichment数据（因为只enrichment top50而不是top150）

---

### 🟠 P1: Enrichment太慢 - 网络延迟瓶颈

**问题分析**:

每个trader的enrichment流程：
```
1. fetchEquityCurve()      → API请求 (500-2000ms)
2. fetchPositionHistory()  → API请求 (500-2000ms)
3. fetchStatsDetail()      → API请求 (500-2000ms)
4. upsertEquityCurve()     → DB write DELETE+INSERT (200-500ms)
5. upsertPositionHistory() → DB write UPSERT (200-500ms)
6. upsertStatsDetail()     → DB write UPSERT (100-300ms)
───────────────────────────────────────────────────────
总时间: 2500-7500ms per trader
```

**并发限制导致线性放大**:
```typescript
// enrichment-runner.ts ENRICHMENT_PLATFORM_CONFIGS
binance_futures: { concurrency: 5, delayMs: 1000 }
// 100个traders = 100/5 = 20批 × (3s avg + 1s delay) = 80秒
// 实际：经常超过120秒因为失败重试

hyperliquid: { concurrency: 3, delayMs: 500 }
// 150个traders = 150/3 = 50批 × (4s avg + 0.5s delay) = 225秒
```

**为什么不能提高concurrency**:
1. API rate limiting（会被ban）
2. Supabase connection pool限制（50连接）
3. 内存限制（Vercel Lambda 1024MB）

---

### 🟠 P1: 数据库写入性能问题

**当前实现**（enrichment-db.ts）:
```typescript
// 每个trader的equity curve写入：
1. DELETE existing data (WHERE source AND trader_id AND period)
2. INSERT 90条新数据 (90天equity curve)

// 每个trader的position history写入：
1. UPSERT 50条position records (逐条conflict check)

// 每个trader的stats detail写入：
1. UPSERT 1条record
```

**问题**:
- DELETE操作需要scan整个表（没有partition）
- 90条INSERT分开执行（没有batch）
- UPSERT的conflict check在每条记录上执行（O(n)）

**测量**（估算）:
```
trader_equity_curve表: 26平台 × 500traders × 90天 = 117万条记录
每次DELETE扫描: ~100ms
每次INSERT 90条: ~200ms
总时间per trader: ~300ms

150 traders × 300ms = 45秒 (仅数据库写入)
```

---

### 🟡 P2: 架构重复 - unified-connector vs legacy fetchers

**问题描述**:

有**两套并行的fetcher系统**：

#### 系统1: legacy fetchers（正在使用）
```
lib/cron/fetchers/
  - binance-futures.ts     (381 lines)
  - binance-spot.ts        (380 lines)
  - okx-futures.ts         (336 lines)
  - gmx.ts                 (279 lines)
  - hyperliquid.ts         (322 lines)
  - dydx.ts                (377 lines)
```

#### 系统2: unified-connector（部分实现，未完全切换）
```
lib/connectors/
  - unified-platform-connector.ts (统一接口)
  - connector-runner.ts (执行引擎)
  - platforms/ (74个connector文件)
```

**重复逻辑**:
1. 每个平台有**两份代码**实现相同功能
2. PLATFORM_CONNECTORS注册了26个平台，但INLINE_FETCHERS只有24个（不一致）
3. API路由也重复：
   - `/api/cron/batch-fetch-traders` (legacy系统)
   - `/api/cron/unified-connector` (新系统，未启用)

**维护成本**:
- Bug需要在两个地方修复
- 新平台需要写两份代码
- 代码总量：17,953行fetcher代码（根据`wc -l`统计）

---

### 🟡 P2: Enrichment逻辑分散（17个文件）

**文件列表**:
```
lib/cron/fetchers/
  enrichment.ts              (barrel export)
  enrichment-runner.ts       (主orchestrator, 739 lines)
  enrichment-types.ts        (共享类型)
  enrichment-db.ts           (数据库写入)
  enrichment-binance.ts      (9660 lines)
  enrichment-bybit.ts        (8119 lines)
  enrichment-okx.ts          (7422 lines)
  enrichment-bitget.ts       (5108 lines)
  enrichment-dex.ts          (14652 lines - GMX+Hyperliquid)
  enrichment-dydx.ts         (5827 lines)
  enrichment-drift.ts        (5213 lines)
  enrichment-copin.ts        (5059 lines - Aevo/Gains/Kwenta)
  enrichment-jupiter.ts      (4470 lines)
  enrichment-onchain.ts      (链上数据 - Gains/Kwenta via Etherscan)
  enrichment-wallet.ts       (钱包余额)
  enrichment-gateio.ts       (5123 lines)
  enrichment-mexc.ts         (...)
  enrichment-htx.ts          (...)
```

**问题**:
1. **没有统一抽象**: 每个平台实现独立逻辑，无法复用
2. **难以优化**: 要优化enrichment速度，需要修改17个文件
3. **测试困难**: 没有统一的mock/test framework
4. **代码膨胀**: 60,000+ 行enrichment代码

---

### 🟡 P2: 技术债务 - 大量失效平台代码

**已删除但代码残留**（根据注释统计）:

#### batch-fetch-traders/route.ts 中标记为REMOVED的平台：
```typescript
// bybit: api2.bybit.com endpoints return 404 globally (2026-03-13)
// bybit_spot: api2.bybit.com endpoints return 404 globally (2026-03-13)
// paradex: API now requires JWT auth since 2026-03
// kwenta: Copin API stopped serving data (2026-03-11)
// blofin: openapi.blofin.com requires auth (2026-03-11)
```

#### lib/cron/fetchers/index.ts 中移除的平台：
```typescript
// Removed: fetchWhitebit (stub — no copy-trading API)
// Removed: fetchBtse (stub — no public leaderboard API)
// Removed: fetchWeex (API returns 521)
// Removed: fetchLbank (API returns "no data")
// Removed: fetchKucoin (API returns 404)
// Removed: fetchCryptocom (WAF blocked, HTTP 403)
// Removed: fetchPionex (WAF blocked, HTTP 403)
// Removed: fetchUniswap (empty_data)
// Removed: fetchPancakeSwap (empty_data)
// Removed: fetchSynthetix (Copin returns only 9 stale traders)
// Removed: fetchMux (requires THEGRAPH_API_KEY)
// Removed: fetchPerpetualProtocol (subgraph deprecated)
```

**问题**:
- 14个失效平台的代码仍在codebase中（虽然不再注册）
- `lib/connectors/platforms/` 下有74个文件，但很多已不再使用
- 增加代码review负担
- 混淆实际支持的平台数量

---

## 3. 技术债务清单（需要重构的部分）

### 🔧 A. 重复的fetcher架构
- [ ] **统一到unified-connector**: 删除6个legacy fetchers，全部使用UnifiedPlatformConnector
- [ ] **清理PLATFORM_CONNECTORS vs INLINE_FETCHERS不一致**: 确保两个registry同步
- [ ] **删除未使用的connector文件**: `lib/connectors/platforms/` 下的74个文件需要audit

### 🔧 B. 分散的enrichment逻辑
- [ ] **抽象EnrichmentProvider接口**: 统一 `fetchEquityCurve/fetchStatsDetail/fetchPositionHistory`
- [ ] **合并相似平台的enrichment**: 
  - CEX平台（Binance/OKX/Bitget）共享90%代码
  - DEX平台（基于GraphQL）可以统一adapter
- [ ] **提取共享逻辑**: retry机制、proxy fallback、rate limiting都应该在base class里

### 🔧 C. 数据库写入性能
- [ ] **改用批量操作**: `INSERT ... ON CONFLICT DO UPDATE` 替代 `DELETE + INSERT`
- [ ] **分区表**: `trader_equity_curve` 按 `(source, period)` 分区
- [ ] **索引优化**: 确保所有WHERE条件都有covering index

### 🔧 D. 失效平台清理
- [ ] **删除14个已移除平台的代码文件**
- [ ] **统一"平台支持列表"**: 在一个地方维护（如 `SUPPORTED_PLATFORMS.ts`）
- [ ] **添加platform health check**: 定期检测API是否仍可用

### 🔧 E. 超时问题缓解
- [ ] **拆分batch-enrich任务**: 不要在一个cron里enrichment所有平台
  - Group A (fast platforms): 5分钟内完成
  - Group B (slow platforms): 10分钟内完成
- [ ] **增量enrichment**: 不要每次都enrichment所有trader，只enrichment新trader
- [ ] **缓存enrichment结果**: equity curve 90天不会变，不需要每天重新fetch

---

## 4. 推荐优化方向（3-5个大方向）

### 🎯 优化方向1: 拆分fetch和enrichment（彻底分离）

**现状问题**:
- batch-fetch-traders曾经包含inline enrichment（已禁用但代码仍在）
- 两者在同一个120s window内执行，互相竞争时间

**建议方案**:

#### Phase 1: 确保fetch和enrichment完全分离
```
batch-fetch-traders (Cloudflare Workers, 120s)
  ↓ 只做leaderboard fetch
  ↓ 写入 trader_snapshots
  ↓
  
batch-enrich (Vercel Lambda, 600s)
  ↓ 读取 trader_snapshots
  ↓ 只做enrichment (equity curve, stats)
  ↓ 写入 trader_equity_curve, trader_stats_detail
```

#### Phase 2: 进一步拆分enrichment batch
```
batch-enrich-fast (5min, 每12小时)
  - binance_futures, okx_futures, bitget_futures
  - API快，不需要长超时

batch-enrich-slow (10min, 每24小时)
  - hyperliquid, gmx, dydx, jupiter_perps
  - GraphQL慢，需要长超时
  
batch-enrich-onchain (15min, 每48小时)
  - gains, kwenta (via Etherscan/Blockscout)
  - 链上数据查询最慢
```

**预期效果**:
- 消除fetch阶段120s超时风险
- 减少enrichment的timeout（专注处理小批量）
- 可以给不同平台不同的enrichment频率（不是所有平台都需要每天enrichment）

---

### 🎯 优化方向2: 数据库批量写入 + 分区表

**现状问题**:
- 每个trader执行3-5次数据库操作（DELETE + INSERT）
- `trader_equity_curve`表有117万条记录，DELETE扫描全表
- 150个traders × 300ms DB time = 45秒浪费在数据库上

**建议方案**:

#### Step 1: 改用UPSERT（消除DELETE）
```sql
-- 当前（慢）:
DELETE FROM trader_equity_curve WHERE source='binance_futures' AND trader_id='xxx' AND period='90D';
INSERT INTO trader_equity_curve VALUES (...), (...), ... (90条);

-- 优化后（快）:
INSERT INTO trader_equity_curve VALUES (...), (...), ... (90条)
ON CONFLICT (source, trader_id, period, data_date) 
DO UPDATE SET roi_pct=EXCLUDED.roi_pct, pnl_usd=EXCLUDED.pnl_usd;
```

#### Step 2: 批量操作（减少round-trips）
```typescript
// 当前: 逐个trader写入
for (const trader of traders) {
  await upsertEquityCurve(trader)  // 1个DB call
  await upsertStatsDetail(trader)  // 1个DB call
}

// 优化后: 批量写入
const allCurves = traders.flatMap(t => t.equityCurve)
await supabase.from('trader_equity_curve')
  .upsert(allCurves, { onConflict: '...' })  // 1个DB call for 150 traders
```

#### Step 3: 表分区（加速查询）
```sql
-- 按 (source, period) 分区
CREATE TABLE trader_equity_curve_binance_90d PARTITION OF trader_equity_curve
  FOR VALUES IN ('binance_futures', '90D');

-- 每个分区更小，DELETE/SELECT更快
```

**预期效果**:
- DB写入时间从45秒降低到5-10秒（10倍提速）
- 减少Supabase connection pool压力
- 为提高enrichment concurrency创造条件

---

### 🎯 优化方向3: Enrichment并行化 + 增量更新

**现状问题**:
- 串行处理每个trader（虽然有小批量concurrency=3-5）
- 每天重新enrichment所有trader（即使数据没变）
- 失败重试浪费时间（15s timeout × 3 retries = 45秒）

**建议方案**:

#### Strategy A: 增量enrichment
```typescript
// 只enrichment新trader或数据过期的trader
const tradersNeedingEnrichment = await supabase
  .from('trader_snapshots')
  .select('*')
  .eq('source', platform)
  .eq('season_id', period)
  .or('last_enriched_at.is.null,last_enriched_at.lt.' + cutoffTime)  // 7天未enrichment
  .order('arena_score', { ascending: false })
  .limit(100)

// 不是每天enrichment所有500个trader，只enrichment需要更新的50个
```

#### Strategy B: 优先级队列
```typescript
// 高优先级: Top 50 traders（用户最常查看）→ 每天enrichment
// 中优先级: Top 50-200 traders → 每3天enrichment
// 低优先级: Top 200-500 traders → 每7天enrichment

const priorityGroups = [
  { range: [0, 50], frequencyHours: 24 },
  { range: [50, 200], frequencyHours: 72 },
  { range: [200, 500], frequencyHours: 168 },
]
```

#### Strategy C: 并行批处理（提高throughput）
```typescript
// 当前: 5个trader并行 × 20批 = 100 traders in 80秒
// 优化: 15个trader并行 × 7批 = 100 traders in 28秒 (前提: 数据库写入优化后)

const CONCURRENCY = 15  // 从5提升到15
const results = await pMap(traders, enrichTrader, { concurrency: CONCURRENCY })
```

**预期效果**:
- 减少90%的enrichment工作量（只enrichment真正需要的trader）
- 提速3倍（更高并发 + 批量DB写入）
- 留出时间处理更多平台

---

### 🎯 优化方向4: 统一fetcher架构 - 完全迁移到unified-connector

**现状问题**:
- 6个legacy fetchers vs 26个unified connectors（重复代码）
- 无法全局优化（修改需要改6个文件）
- 新平台需要写两份代码（legacy + unified）

**建议方案**:

#### Step 1: 定义统一接口
```typescript
interface PlatformConnector {
  platform: string
  
  // Phase 1: Fetch leaderboard
  fetchLeaderboard(params: {
    window: '7d' | '30d' | '90d'
    page: number
    pageSize: number
  }): Promise<TraderSnapshot[]>
  
  // Phase 2: Enrichment (optional, 不是所有平台都支持)
  enrichTrader?(traderId: string): Promise<{
    equityCurve: EquityCurvePoint[]
    positions: PositionHistoryItem[]
    stats: StatsDetail
  }>
}
```

#### Step 2: 迁移6个legacy fetchers
```typescript
// 删除:
lib/cron/fetchers/binance-futures.ts (381 lines)
lib/cron/fetchers/binance-spot.ts (380 lines)
...

// 统一使用:
lib/connectors/platforms/binance-futures.ts
  → 继承 BaseCEXConnector
  → 只需实现平台特定的API调用逻辑
  → 共享proxy fallback, retry, rate limiting
```

#### Step 3: 提取共享逻辑到BaseConnector
```typescript
abstract class BaseCEXConnector implements PlatformConnector {
  // 共享逻辑:
  protected async fetchWithRetry(url, opts) { ... }      // 3次重试
  protected async fetchWithProxyFallback(url) { ... }   // VPS proxy
  protected applyRateLimit() { ... }                    // 自动限速
  
  // 子类实现:
  abstract buildApiUrl(params): string
  abstract parseResponse(data): TraderSnapshot[]
}

class BinanceFuturesConnector extends BaseCEXConnector {
  buildApiUrl(params) {
    return 'https://www.binance.com/bapi/futures/...'
  }
  
  parseResponse(data) {
    return data.data.list.map(t => ({
      source_trader_id: t.portfolioId,
      roi: t.roi * 100,  // Binance uses decimal
      ...
    }))
  }
}
```

**预期效果**:
- 减少50%代码量（消除重复）
- 新平台开发时间从2小时降低到30分钟
- 全局优化一次生效所有平台（如改进retry逻辑）

---

### 🎯 优化方向5: 缓存 + CDN - 避免重复计算

**现状问题**:
- 每次用户访问trader页面都查询数据库
- equity curve 90天数据不会变，但每天重新fetch
- 排行榜数据在短时间内不变，但每个请求都重新计算

**建议方案**:

#### Cache Layer 1: Redis缓存（热数据）
```typescript
// 缓存trader的enrichment数据（24小时TTL）
const cacheKey = `enrichment:${platform}:${traderId}:${period}`
const cached = await redis.get(cacheKey)
if (cached) return JSON.parse(cached)

// 未命中才查询数据库 + API
const fresh = await fetchAndEnrichTrader(traderId)
await redis.setex(cacheKey, 86400, JSON.stringify(fresh))
```

#### Cache Layer 2: 预计算排行榜（每小时更新）
```typescript
// 当前: 每个请求都 SELECT + ORDER BY + LIMIT
// 优化: cron job每小时计算一次，存入Redis

// cron: compute-leaderboard (every 1 hour)
const leaderboard = await computeLeaderboard('binance_futures', '90D', limit=500)
await redis.setex('leaderboard:binance_futures:90D', 3600, JSON.stringify(leaderboard))

// API: 直接读取缓存
const cached = await redis.get('leaderboard:binance_futures:90D')
return JSON.parse(cached)  // 0.5ms vs 500ms DB query
```

#### Cache Layer 3: CDN静态化（equity curve数据）
```typescript
// equity curve 90天不变，可以生成静态JSON文件
// cron: 每天生成一次，上传到S3/R2
const equityCurve = await buildEquityCurve(traderId, '90D')
await uploadToR2(`curves/${platform}/${traderId}/90d.json`, equityCurve)

// 前端直接从CDN读取:
fetch('https://cdn.ranking-arena.com/curves/binance_futures/xxx/90d.json')
  → Cloudflare CDN cache (全球分发，延迟<50ms)
```

**预期效果**:
- 减少90%数据库查询（热数据命中率90%+）
- API响应时间从500ms降低到5ms（Redis）或50ms（CDN）
- 降低Supabase成本（减少query量）

---

## 总结

### 当前架构的3个最大问题：

1. **超时限制太紧** - Cloudflare 120s + Lambda 600s 限制了能处理的数据量
2. **Enrichment太慢** - 串行API调用 + 数据库写入 = 每trader 5-7秒
3. **架构重复** - 两套fetcher系统 + 17个enrichment文件 = 维护困难

### 优先级推荐：

**Q1 2026（短期）- 稳定性优先**:
1. ✅ 拆分batch-enrich（fast/slow/onchain groups）- 已经在做
2. ✅ 数据库批量写入优化（UPSERT替代DELETE+INSERT）
3. 🔄 增量enrichment（不要每天重新enrichment所有trader）

**Q2 2026（中期）- 性能优化**:
4. 📈 提高enrichment并发（从5提升到15）- 前提是DB优化完成
5. 🗄️ Redis缓存层（减少数据库查询）
6. 🧹 清理技术债务（删除失效平台代码）

**Q3 2026（长期）- 架构重构**:
7. 🏗️ 统一到unified-connector（删除legacy fetchers）
8. 📦 抽象EnrichmentProvider接口（合并17个enrichment文件）
9. 🌐 CDN静态化（equity curve数据）

---

**关键指标跟踪**:

| 指标 | 当前值 | 目标值 | 优化方向 |
|------|--------|--------|---------|
| batch-enrich timeout率 | 30% | <5% | 拆分batch + 增量更新 |
| enrichment速度 (per trader) | 5-7s | <2s | 批量DB写入 + 并发提升 |
| 代码重复率 | ~50% | <10% | 统一到unified-connector |
| enrichment覆盖率 | Top 50 | Top 200 | 减少per-trader时间 |
| API响应时间 (leaderboard) | 500ms | <50ms | Redis缓存 |
| 数据新鲜度 | 每天 | 热门trader每12小时 | 优先级队列 |

---

**下一步行动**:
1. 立即：实现数据库批量写入优化（预计节省40秒/batch）
2. 本周：拆分batch-enrich为3个独立jobs（消除600s timeout）
3. 下周：实现增量enrichment（减少90%工作量）
4. 本月：添加Redis缓存层（加速API响应）
