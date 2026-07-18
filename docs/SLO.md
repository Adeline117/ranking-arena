# Arena SLO（Service Level Objectives）

> 2026-07-02 首版（企业级差距整改 E3）。原则：先少而真，宁可 4 条真执行，
> 不要 20 条没人看。每条 SLO 必须有：测量方式（现有工具）+ 告警阈值 + 违约动作。
> 复盘制度见 docs/postmortems/。

## SLO 清单

### 1. 核心页面可用性 ≥ 99.5%（月）

- **定义**：`/`、`/rankings`、trader 详情、`/login`、`/pricing` 非 5xx 比例
- **测量**：post-deploy-smoke.yml（每次部署）+ health-monitor.yml（30min 轮询）
- **告警**：任一 URL 500 → Telegram 立即（现有）；月累计 downtime > 3.6h → 复盘
- **违约动作**：立即回滚 + 24h 内写 postmortem

### 2. API 健康端点 p95 < 200ms，错误率 < 1%（周）

- **定义**：`/api/health`（edge，设计目标 <200ms）为代表的 API 层健康
- **测量**：health-monitor 记录响应时间；Sentry 错误率
- **告警**：health 端点连续 3 次 >1s 或不可达 → Telegram
- **违约动作**：查 Vercel region/Supabase pool/Redis，参照 RUNBOOK

### 3. 数据新鲜度：默认源 < 8h（tier A 产品目标 ≤ 2h）

- **定义**：这里有两只不能混用的时钟。serving publish lag 衡量一次完整排名发布
  何时完成；upstream freshness 则取当前 active + serving registry 对每个公开来源、
  每个 7D/30D/90D board 承诺的 `leaderboard_source_freshness.source_as_of`，
  同一公开来源以最旧 board 为准。`leaderboard_ranks.computed_at` 只是重算分时间，
  不能证明上游更新。
- **当前执行门槛**：默认来源 `>=8h` 为 stale、`>=24h` 为 critical；
  BloFin/GMX/Gains 等慢源按代码中的 48h/72h override。缺失、非法、超前或
  registry 承诺但当前榜单不可见，一律为 unknown critical。Tier A `≤2h` 仍是
  产品目标；在 registry 有可执行 tier 策略前，不把它伪装成已有 pager。
- **测量**：无告警只读 `/api/admin/data-freshness`；生产
  `/api/cron/check-data-freshness` 每 3 小时 UTC `:39` 执行；meta-monitor
  每 6 小时检查其最近成功记录，并按 180 分钟期望间隔的 2 倍判定失联。
- **告警**：unknown/critical → Telegram + Sentry；stale 进入 warning 路径。
  检查成功发现旧数据仍记作 pipeline success，因为 meta-monitor 监控的是
  “检查有没有运行”，不是把数据健康误写成执行失败。
- **违约动作**：先查对应 ingest worker/adapter 和最近
  count-check-PASSED snapshot，再完成一次无错误排名发布。不得手改
  `source_as_of`，也不得用 `computed_at` 或 `now()` 回填来制造假新鲜；
  数据不可信时宁可显示 stale 标记也不静默喂旧数据。

### 4. 备份新鲜度 ≤ 26h + 可恢复

- **定义**：R2 上最新 pg_dump 距今 ≤ 26h（日备 + 2h 容差）
- **测量**：备份新鲜度哨兵（scripts/openclaw/backup-freshness-check.mjs，
  随 health monitor cron 跑）
- **告警**：>26h → Telegram
- **违约动作**：查 Mac Mini local-cron-backup；连续 2 天失败 = SEV2，
  手动跑 `npm run backup:r2` 补一份
- **恢复演练**：每季度从 R2 拉一份到本地 psql 恢复验证一次（企业级要求
  "备份可恢复才算备份"——只备不演练等于没备）

### 5. 写路径可用性（发帖→赞→评论→删）

- **定义**：核心社交写链路端到端可用
- **测量**：写路径金丝雀（schema-canary-sentinel，每日 7:30 + 每次部署后）
- **告警**：金丝雀失败 → Telegram（现有）
- **违约动作**：优先排查 schema/RLS 漂移（PM-202606-migration-drift 的教训）

## 错误预算的朴素用法（solo 模式）

不搞正式 error budget 记账。规则一条：**任一 SLO 单月第二次违约 → 该领域
冻结新功能，先做可靠性整改**（防止"修了又坏"的循环消耗）。

## 与告警的对应关系

| 告警                                | 级别 | 响应                           |
| ----------------------------------- | ---- | ------------------------------ |
| smoke 失败 / 核心 URL 500           | SEV1 | 立即回滚（自动回滚上线后自动） |
| 写路径金丝雀失败                    | SEV2 | 当日排查 schema/RLS            |
| 数据 critical stale / 节点 SHA 漂移 | SEV2 | 当日查 worker                  |
| 备份 >26h                           | SEV2 | 当日补备份                     |
| health p95 劣化 / moderate stale    | SEV3 | 本周内处理                     |
