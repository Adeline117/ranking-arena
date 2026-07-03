# Arena 架构（数据流 + 拓扑）

> 2026-07-02 首版（Phase 2 知识文档化）。之前审计指出全项目无架构图——本文补上。
> 与 `docs/system-principles.md`（设计原则）、`docs/INGEST_WORKER_TOPOLOGY.md`（worker 节点）、
> `docs/DECISIONS.md`（为什么这么做）配套。数值以 `memory/MEMORY.md` 的实测为准。

## 一、系统全景

```mermaid
graph TD
  subgraph Sources[交易所 web/API · 36 sources]
    CEX[CEX: binance/bybit/okx/bitget/...]
    DEX[DEX: hyperliquid/gmx/dydx/...]
  end

  subgraph Ingest[Arena Ingest Worker · lib/ingest/adapters]
    direction LR
    A[Tier A 队列]
    B[Tier B]
    C[Tier C]
    D[Tier D]
  end

  subgraph ArenaSchema[arena.* schema · Supabase Postgres]
    SNAP[leaderboard_snapshots/entries]
    STATS[trader_stats · 主 perf 表]
    POS[positions_* · 月分区]
  end

  Serving[compute-leaderboard → public.leaderboard_ranks + lr_7d/30d/90d]
  Redis[(Upstash Redis)]
  FE[Next.js 前端 · Vercel hnd1]

  CEX --> Ingest
  DEX --> Ingest
  Ingest --> SNAP
  Ingest --> STATS
  Ingest --> POS
  STATS --> Serving
  SNAP --> Serving
  Serving --> Redis
  Redis --> FE
  FE -->|读| Serving
```

## 二、数据管道（写路径）

```mermaid
sequenceDiagram
  participant EX as 交易所
  participant W as Ingest Worker (Mac Mini + SG VPS)
  participant ST as lib/ingest/staging/validate.ts
  participant DB as arena.* (Supabase)
  participant CL as compute-leaderboard (cron)
  participant SV as public.leaderboard_ranks

  EX->>W: fetchLeaderboard/Details (tier A/B/C/D)
  W->>ST: clampRoi/boundPct（roi→[-10000,10000], mdd/win_rate→null if 越界）
  ST->>DB: 写 arena.trader_stats / snapshots / positions（源 garbage 不落库）
  CL->>DB: 读 arena.trader_stats
  CL->>SV: 派生 Arena Score → leaderboard_ranks + lr_7d/30d/90d
  SV->>SV: 服务 RPC 再 clamp（defense-in-depth）
```

**关键约束**：指标净化在 **staging 边界**（`lib/ingest/staging/validate.ts`）——
源返回的 garbage（mdd 140665%、kucoin roi 2.19e9）永不落库；服务 RPC
（`arena_core_modules`/`arena_first_screen`）再 clamp 一次。详见 DECISIONS ADR-004。

## 三、Arena Score 公式

```
ReturnScore = 60 * tanh(coeff * ROI)^exponent        (0-60)
PnlScore    = 40 * tanh(coeff * ln(1 + PnL/base))     (0-40)
Arena Score = (ReturnScore + PnlScore) * confidenceMultiplier * trustWeight
Overall     = 90D×0.70 + 30D×0.25 + 7D×0.05
```

系数随周期变（`lib/utils/arena-score.ts`）。

## 四、基础设施拓扑

```mermaid
graph LR
  subgraph Vercel[Vercel hnd1]
    APP[Next.js App + API]
    CRON[44 Vercel Crons]
    GATE[deploy-gate.yml CI 门禁部署]
  end
  subgraph Supabase[Supabase us-west-2 ~24GB]
    PG[(Postgres 17 · arena.* + public.*)]
    AUTH[Auth]
    RLS[RLS on all tables]
  end
  subgraph Nodes[Ingest Worker 双节点]
    MM[Mac Mini · regions local,vps_jp · PM2/BullMQ]
    SG[SG VPS 45.76.152.169 · region vps_sg · rsync copy]
  end
  MEILI[Meilisearch @ SG VPS]
  REDIS[(Upstash Redis)]
  R2[(Cloudflare R2 · 日备)]
  GH[GitHub Actions · CI + 哨兵冗余]

  APP --> PG
  APP --> REDIS
  APP --> MEILI
  MM --> PG
  SG --> PG
  MM --> R2
  GH -.冗余监控/备份哨兵.-> APP
  GATE --> APP
```

**单点提示（差距 #2，见 `docs/PHASE2_INFRA_PLAN.md`）**：Mac Mini（运维+备份编排+
phemex 抓取）、SG/JP VPS（scraper/proxy/Meilisearch）仍是单点；抓取类因住宅 IP
反封锁**必须**留本地。监控/告警已有 GH Actions 冗余（`health-monitor.yml` +
`openclaw-sentinels.yml`，2026-07-02）。

## 五、部署与质量门禁流

```mermaid
graph TD
  PUSH[git push main] --> CI[ci.yml: 4 门禁作业]
  CI -->|全绿| DG[deploy-gate.yml]
  CI -->|红| HOLD[扣留部署 + Telegram]
  DG --> ANC{ancestry: 比线上新?}
  ANC -->|是| DEPLOY[Vercel CLI 部署 --meta gateSha]
  ANC -->|否/超越| SKIP[跳过]
  DEPLOY --> SMOKE[内嵌 smoke 5 URL]
  SMOKE -->|失败| RB[promote 上一个 READY 回滚 v10]
  SMOKE -->|绿| DONE[生产更新]
  PUSH -. "[deploy-force] 逃生口" .-> DEPLOY
```

详见 DECISIONS ADR-011 + `docs/RUNBOOK.md` 部署管线。

## 六、关键文件索引

| 层                 | 位置                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------- |
| Ingest adapters    | `lib/ingest/adapters/<source>/`（NOT lib/connectors）                                   |
| Ingest worker 入口 | `worker/src/ingest-worker.ts`（tier A/B/C/D）                                           |
| 指标净化           | `lib/ingest/staging/validate.ts` + `lib/pipeline/validate-before-write.ts`              |
| 主 perf 表         | `arena.trader_stats`（trader_latest/v2 已 DROP 2026-06-16）                             |
| 服务层             | `public.leaderboard_ranks` + `lr_7d/30d/90d`                                            |
| Arena Score        | `lib/utils/arena-score.ts`                                                              |
| 缓存预设           | `lib/hooks/cache-presets.ts`                                                            |
| Auth 原语          | `lib/api/with-cron.ts`/`with-admin-auth.ts`/`auth.ts`/`lib/auth/`                       |
| 数据获取           | Server `lib/data/*`；Client `lib/hooks/use*`（React Query）；Cache `lib/cache/redis.ts` |
