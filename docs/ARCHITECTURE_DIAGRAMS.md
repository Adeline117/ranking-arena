# Arena Pipeline 架构图详解

## 1. 当前架构流程图

```mermaid
sequenceDiagram
    participant User
    participant Cloudflare
    participant Vercel
    participant DB
    
    Note over Vercel: Cron Job (每3-6h)
    Vercel->>Vercel: batch-fetch-traders<br/>(600s maxDuration)
    Vercel->>DB: 写入trader数据
    
    Note over Vercel: Cron Job (每4h)
    Vercel->>Vercel: batch-enrich<br/>(600s maxDuration)<br/>❌经常超时
    Vercel->>DB: 写入enrichment数据
    
    Note over Vercel: Cron Job (每30min)
    Vercel->>Vercel: compute-leaderboard
    Vercel->>DB: 写入排名cache
    
    User->>Cloudflare: GET /api/rankings
    Note over Cloudflare: ⏱️ 120s timeout
    Cloudflare->>Vercel: Forward request
    Note over Vercel: ⏱️ 60s timeout
    Vercel->>DB: 读取cache
    DB-->>Vercel: 返回数据
    Vercel-->>Cloudflare: Response
    Cloudflare-->>User: 返回排行榜
```

## 2. 新架构流程图

```mermaid
graph TB
    subgraph "用户层"
        User[用户请求]
    end
    
    subgraph "边缘层 (Cloudflare)"
        CDN[Cloudflare CDN<br/>120s timeout]
    end
    
    subgraph "应用层 (Vercel)"
        API[Edge Function<br/>/api/rankings<br/>< 60s]
        Cron[Vercel Cron<br/>batch-fetch-traders<br/>600s]
    end
    
    subgraph "缓存层 (Redis)"
        L1[L1 Cache<br/>基础leaderboard<br/>TTL: 60s]
        L2[L2 Cache<br/>Enrichment数据<br/>TTL: 3h]
        L3[L3 Cache<br/>预计算metrics<br/>TTL: 24h]
        Queue[BullMQ Queue<br/>3个优先级队列]
    end
    
    subgraph "数据层"
        DB[(Supabase<br/>PostgreSQL)]
    end
    
    subgraph "Worker层 (Railway)"
        Worker1[Worker 1<br/>High Priority]
        Worker2[Worker 2<br/>Medium Priority]
        Worker3[Worker 3<br/>Low Priority]
    end
    
    User --> CDN
    CDN --> API
    
    API --> L1
    L1 -->|cache miss| DB
    API --> L2
    L2 -->|cache miss| Queue
    
    Cron --> DB
    Cron --> Queue
    
    Queue --> Worker1
    Queue --> Worker2
    Queue --> Worker3
    
    Worker1 --> L2
    Worker2 --> L2
    Worker3 --> L2
    
    Worker1 --> DB
    Worker2 --> DB
    Worker3 --> DB
    
    style User fill:#e1f5ff
    style CDN fill:#ffe1e1
    style API fill:#fff3cd
    style L1 fill:#d4edda
    style L2 fill:#d4edda
    style L3 fill:#d4edda
    style Queue fill:#f8d7da
    style Worker1 fill:#cce5ff
    style Worker2 fill:#cce5ff
    style Worker3 fill:#cce5ff
    style DB fill:#e2e3e5
```

## 3. Fetch → Enrich数据流

```mermaid
sequenceDiagram
    participant Cron as Vercel Cron
    participant Fetch as batch-fetch-traders
    participant Queue as BullMQ Queue
    participant Worker as Railway Worker
    participant Redis as Redis Cache
    participant DB as Supabase
    
    Note over Cron: 每3-6小时触发
    Cron->>Fetch: 触发fetch job
    
    loop 26个平台并行
        Fetch->>Fetch: 调用fetcher<br/>(420s timeout)
        Fetch->>DB: 写入trader_snapshots_v2
    end
    
    Note over Fetch: Fetch完成，触发enrichment
    Fetch->>Queue: 推送26个platform jobs<br/>(high/medium/low priority)
    
    Note over Queue,Worker: 异步处理，无超时限制
    
    par Worker并行处理
        Queue->>Worker: Platform 1 job
        Worker->>Worker: runEnrichment()<br/>无超时限制
        Worker->>DB: 写入equity_curves
        Worker->>DB: 写入position_history
        Worker->>DB: 写入stats_detail
        Worker->>Redis: 更新L2 cache
    and
        Queue->>Worker: Platform 2 job
        Worker->>Worker: runEnrichment()
        Worker->>DB: 写入enrichment数据
        Worker->>Redis: 更新L2 cache
    and
        Queue->>Worker: Platform N job
        Worker->>Worker: runEnrichment()
        Worker->>DB: 写入enrichment数据
        Worker->>Redis: 更新L2 cache
    end
    
    Note over Worker: 所有platform enrichment完成
```

## 4. 用户请求分层缓存流程

```mermaid
sequenceDiagram
    participant User
    participant API as /api/rankings
    participant L1 as L1 Cache<br/>(Redis)
    participant DB
    participant Queue as BullMQ Queue
    participant Worker
    
    User->>API: GET /api/rankings?window=30d
    
    API->>L1: 查询 leaderboard:30d
    
    alt L1 Cache Hit
        L1-->>API: 返回基础数据<br/>(arena_score, roi, pnl)
        API-->>User: 200 OK<br/>enrichmentStatus: cached
    else L1 Cache Miss
        L1-->>API: null
        API->>DB: 查询trader_snapshots_v2
        DB-->>API: 返回基础数据
        API->>L1: 写入cache (TTL 60s)
        API-->>User: 200 OK<br/>enrichmentStatus: pending
    end
    
    Note over User: 用户点击查看trader详情
    User->>API: GET /api/trader/123/equity-curve
    
    API->>L1: 查询 equity_curve:123:30d
    
    alt L2 Cache Hit
        L1-->>API: 返回equity curve数据
        API-->>User: 200 OK
    else L2 Cache Miss
        L1-->>API: null
        API->>DB: 查询equity_curves表
        
        alt DB有数据
            DB-->>API: 返回equity curve
            API->>L1: 写入L2 cache (TTL 3h)
            API-->>User: 200 OK
        else DB无数据（需要enrichment）
            DB-->>API: null
            Note over API: 触发按需enrichment
            API->>Queue: 推送high priority job<br/>(trader_id: 123)
            API-->>User: 202 Accepted<br/>status: pending<br/>retry_after: 30s
            
            Note over Queue,Worker: 后台处理
            Queue->>Worker: 处理enrichment job
            Worker->>DB: 写入equity curve
            Worker->>L1: 更新L2 cache
        end
    end
```

## 5. BullMQ队列优先级处理

```mermaid
graph LR
    subgraph "Job生产者"
        Fetch[batch-fetch-traders]
        OnDemand[按需enrichment]
    end
    
    subgraph "BullMQ Queues"
        HighQ[High Priority Queue<br/>- 按需enrichment<br/>- Top 10 platforms]
        MediumQ[Medium Priority Queue<br/>- 定期enrichment<br/>- Top 10-20 platforms]
        LowQ[Low Priority Queue<br/>- 低优先级平台<br/>- 历史数据backfill]
    end
    
    subgraph "Workers (Railway)"
        W1[Worker 1<br/>并发度: 5]
        W2[Worker 2<br/>并发度: 5]
        W3[Worker 3<br/>并发度: 3]
    end
    
    subgraph "输出"
        Redis[(Redis<br/>L2 Cache)]
        DB[(Supabase)]
    end
    
    Fetch -->|批量job| MediumQ
    OnDemand -->|单个trader| HighQ
    
    HighQ -->|优先处理| W1
    MediumQ --> W2
    LowQ --> W3
    
    W1 --> Redis
    W1 --> DB
    W2 --> Redis
    W2 --> DB
    W3 --> Redis
    W3 --> DB
    
    style HighQ fill:#ff6b6b
    style MediumQ fill:#ffa500
    style LowQ fill:#4ecdc4
    style W1 fill:#95e1d3
    style W2 fill:#95e1d3
    style W3 fill:#95e1d3
```

## 6. Worker内部处理流程

```mermaid
flowchart TD
    Start([接收Job]) --> Parse[解析Job数据<br/>platform, period, traders]
    Parse --> Config[加载平台配置<br/>concurrency, timeout, limits]
    
    Config --> Batch[分批处理traders<br/>batch_size = 50]
    
    Batch --> Loop{还有batch?}
    
    Loop -->|是| Process[处理当前batch]
    Process --> Parallel[并行enrichment<br/>concurrency = 5]
    
    Parallel --> Fetch1[Fetch Equity Curve]
    Parallel --> Fetch2[Fetch Stats Detail]
    Parallel --> Fetch3[Fetch Position History]
    
    Fetch1 --> Retry1{成功?}
    Fetch2 --> Retry2{成功?}
    Fetch3 --> Retry3{成功?}
    
    Retry1 -->|失败| Retry1Logic[指数退避重试<br/>max 3次]
    Retry2 -->|失败| Retry2Logic[指数退避重试<br/>max 3次]
    Retry3 -->|失败| Retry3Logic[指数退避重试<br/>max 3次]
    
    Retry1Logic --> Retry1
    Retry2Logic --> Retry2
    Retry3Logic --> Retry3
    
    Retry1 -->|成功| WriteDB1[写入equity_curves]
    Retry2 -->|成功| WriteDB2[写入stats_detail]
    Retry3 -->|成功| WriteDB3[写入position_history]
    
    WriteDB1 --> WriteCache1[写入L2 Cache]
    WriteDB2 --> WriteCache2[写入L2 Cache]
    WriteDB3 --> WriteCache3[写入L2 Cache]
    
    WriteCache1 --> NextBatch[下一个batch]
    WriteCache2 --> NextBatch
    WriteCache3 --> NextBatch
    
    NextBatch --> Loop
    
    Loop -->|否| Complete[标记Job完成]
    Complete --> Metrics[记录metrics<br/>- 耗时<br/>- 成功率<br/>- 失败原因]
    Metrics --> End([返回结果])
    
    style Start fill:#e1f5ff
    style End fill:#d4edda
    style Process fill:#fff3cd
    style Parallel fill:#ffe1e1
    style Complete fill:#d4edda
```

## 7. 监控告警流程

```mermaid
graph TB
    subgraph "数据采集"
        Worker[Worker Metrics]
        Queue[Queue Metrics]
        Redis[Redis Metrics]
        API[API Metrics]
    end
    
    subgraph "Metrics存储"
        Prometheus[Prometheus<br/>可选]
        Logs[Worker Logs]
    end
    
    subgraph "告警规则"
        Rule1[Queue堆积 > 500]
        Rule2[Worker错误率 > 5%]
        Rule3[Enrichment超时率 > 10%]
        Rule4[L1缓存命中率 < 80%]
        Rule5[Redis内存使用 > 80%]
    end
    
    subgraph "告警渠道"
        Slack[Slack通知]
        Email[Email通知]
        PagerDuty[PagerDuty<br/>紧急告警]
    end
    
    Worker --> Prometheus
    Queue --> Prometheus
    Redis --> Prometheus
    API --> Prometheus
    
    Worker --> Logs
    
    Prometheus --> Rule1
    Prometheus --> Rule2
    Logs --> Rule3
    Prometheus --> Rule4
    Prometheus --> Rule5
    
    Rule1 -->|触发| Slack
    Rule2 -->|触发| Email
    Rule3 -->|触发| PagerDuty
    Rule4 -->|触发| Slack
    Rule5 -->|触发| Email
    
    style Rule1 fill:#ff6b6b
    style Rule2 fill:#ff6b6b
    style Rule3 fill:#ff0000
    style Rule4 fill:#ffa500
    style Rule5 fill:#ffa500
```

## 8. 灰度发布流程

```mermaid
flowchart LR
    subgraph "Week 1-2: 搭建"
        Build[搭建新架构<br/>Feature Flag OFF]
    end
    
    subgraph "Week 3: 10%流量"
        Test10[10%流量测试]
        Monitor10[监控24小时]
        Check10{错误率<1%?}
    end
    
    subgraph "Week 3: 50%流量"
        Test50[50%流量测试]
        Monitor50[监控48小时]
        Check50{性能达标?}
    end
    
    subgraph "Week 4: 100%流量"
        Test100[100%流量切换]
        Monitor100[监控7天]
        Check100{稳定运行?}
    end
    
    subgraph "Week 4: 清理"
        Cleanup[移除旧代码<br/>删除旧cron job]
    end
    
    Build --> Test10
    Test10 --> Monitor10
    Monitor10 --> Check10
    
    Check10 -->|是| Test50
    Check10 -->|否| Rollback1[回滚到0%]
    Rollback1 --> Debug1[调试修复]
    Debug1 --> Test10
    
    Test50 --> Monitor50
    Monitor50 --> Check50
    
    Check50 -->|是| Test100
    Check50 -->|否| Rollback2[回滚到10%]
    Rollback2 --> Debug2[调试修复]
    Debug2 --> Test50
    
    Test100 --> Monitor100
    Monitor100 --> Check100
    
    Check100 -->|是| Cleanup
    Check100 -->|否| Rollback3[回滚到50%]
    Rollback3 --> Debug3[调试修复]
    Debug3 --> Test100
    
    style Build fill:#e1f5ff
    style Cleanup fill:#d4edda
    style Rollback1 fill:#ff6b6b
    style Rollback2 fill:#ff6b6b
    style Rollback3 fill:#ff6b6b
```

## 9. 新旧架构对比

| 维度 | 当前架构 | 新架构 |
|------|----------|--------|
| **Fetch阶段** | Vercel cron → batch-fetch-traders (600s) | 保持不变 ✅ |
| **Enrich阶段** | Vercel cron → batch-enrich (600s) ❌超时 | BullMQ Queue → Railway Worker (无限制) ✅ |
| **缓存策略** | 单层（compute-leaderboard） | 三层（L1/L2/L3） ✅ |
| **超时限制** | Cloudflare 120s + Vercel 600s ❌ | Worker无限制 ✅ |
| **并发处理** | 固定7个平台 | 动态扩展（增加worker） ✅ |
| **按需enrichment** | 不支持 ❌ | 支持（high priority queue） ✅ |
| **数据新鲜度** | 3-6小时 | 实时（按需触发） ✅ |
| **扩展性** | 受限于600s ❌ | 可扩展到50+平台 ✅ |
| **成本** | $45/月 | $95/月 (+111%) |
| **复杂度** | 低 | 中（需维护queue + worker） |

## 10. 性能对比预测

```mermaid
gantt
    title Enrichment时间对比（26个平台）
    dateFormat  X
    axisFormat %s
    
    section 当前架构
    Platform 1-7  :a1, 0, 180s
    Platform 8-14 :a2, 180, 180s
    Platform 15-21:a3, 360, 180s
    Platform 22-26:a4, 540, 120s
    ❌超时（>600s）:crit, a5, 600, 60s
    
    section 新架构（Worker）
    Platform 1-26并行 :b1, 0, 180s
    ✅完成（<200s） :active, b2, 180, 20s
```

**说明**：
- **当前架构**：顺序分批处理（7个一批），总耗时~660s，超过600s限制
- **新架构**：26个平台完全并行，单个最慢180s，总耗时<200s

---

## 总结

新架构通过引入**BullMQ队列 + Railway Worker + 分层缓存**，实现：

1. ✅ **根本解决超时问题**（worker无600s限制）
2. ✅ **提升并发能力**（26个平台完全并行）
3. ✅ **按需enrichment**（用户查看时实时补充）
4. ✅ **分层缓存**（L1快速返回 + L2异步补充）
5. ✅ **可扩展性**（轻松支持50+平台）

**关键改进点**：
- Enrich阶段从Vercel迁移到Railway（绕过超时限制）
- 引入BullMQ队列（可靠性 + 优先级控制）
- 三层缓存（平衡速度和新鲜度）
- 灰度发布（降低风险）
