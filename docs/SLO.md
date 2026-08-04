# Arena SLO（Service Level Objectives）

> 2026-07-02 首版（企业级差距整改 E3）。原则：先少而真，宁可 4 条真执行，
> 不要 20 条没人看。每条 SLO 必须有：测量方式（现有工具）+ 告警阈值 + 违约动作。
> 复盘制度见 docs/postmortems/。
>
> **2026-08-04 evidence status:** SLO 是目标，不等于当前达标证明。GitHub Actions
> 目前缺 `CRON_SECRET`、`BACKUP_DATABASE_URL`、`R2_ACCESS_KEY_ID` 和
> `R2_SECRET_ACCESS_KEY`；health/backup workflows 会 fail-closed，但在轮换补齐前
> 不能充当有效监控或备份证据。生产 freshness 同时处于真实 degraded 状态。

## SLO 清单

### 1. 核心页面可用性 ≥ 99.5%（月）

- **定义**：`/`、`/rankings`、trader 详情、`/login`、`/pricing` 非 5xx 比例
- **测量**：post-deploy smoke（每次 Deploy Gate）+ health-monitor（目标 30min；
  当前因 GitHub 缺 `CRON_SECRET` 暂停有效探测）
- **告警**：任一 URL 500 → Telegram 立即（现有）；月累计 downtime > 3.6h → 复盘
- **违约动作**：立即回滚 + 24h 内写 postmortem

### 2. API 健康端点 p95 < 200ms，错误率 < 1%（周）

- **定义**：`/api/health`（edge，设计目标 <200ms）为代表的 API 层健康
- **测量**：health-monitor 做可用性探测，Sentry 提供错误证据；当前没有可审计的
  周 p95 时序聚合，因此 p95 目标仍是观测缺口，不能仅凭单次 curl 宣称达标
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
- **2026-08-04 状态**：生产 `/api/health` 报告 32 个受管来源中 4 fresh、13 stale、
  15 critical；本 SLO 当前违约，必须恢复 worker/source ownership，禁止放宽阈值。

### 4. 应用数据备份新鲜度 ≤ 26h；完整恢复尚未达标

- **定义**：R2 上最新、同时通过共享 schemas/full 文件名、`HeadObject`
  大小/ETag、范围元数据与完成 token 契约的 pg_dump 距今 ≤ 26h（日备 + 2h 容差）。
  任意 `.sql.gz`、旧无范围后缀 partial、`NaN` 大小或只有 LIST 元数据都不计入。
- **测量**：备份新鲜度哨兵（`scripts/openclaw/backup-freshness-check.mjs`，
  随 health monitor cron 跑）。最新候选的 HEAD 契约失败必须报红，不得回退旧对象报绿。
- **告警**：无合格对象、HEAD 契约失败或 >26h → Telegram；告警发送非 2xx 也算检查失败。
- **违约动作**：查 GitHub `backup-db` 与 Mac Mini `backup:r2` 日程；连续 2 天失败 =
  SEV2。先由授权 operator 轮换/补齐只读 `BACKUP_DATABASE_URL`、最小权限 R2
  credentials 和显式 `R2_BUCKET`，完成不输出端点/凭据的连通性验证，再从最新
  reviewed `main` dispatch。成功任务会写入并按 retention 删除 R2 对象，不能把
  本地命令当成无副作用诊断。
- **2026-08-04 状态**：GitHub 日备已连续失败且所需连接/写凭据不完整；在下一次
  通过 artifact + HEAD + freshness attestation 前，本 SLO 无当前达标证据。
- **恢复状态**：本 SLO 的“完整恢复”门当前**未通过**。`arena+public` 不含托管
  `auth`，plain dump 在 fresh PostgreSQL/managed Supabase 的既有 `public/auth`
  catalog 上也有冲突。只有应用 dump、同一一致性点的 auth data-only sidecar、配对
  manifest、目标 catalog 兼容检查和隔离 managed scratch 演练全部通过，才能改为
  “可恢复”。此后仍须每季度重跑并记录 RPO/RTO。

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
