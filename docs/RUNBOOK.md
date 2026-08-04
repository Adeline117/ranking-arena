# Arena Operations Runbook

Emergency operations manual for the Arena crypto trader ranking platform.

> **Current incident overlay (2026-08-03): NO-GO.**
> [`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md) is
> the launch authority. Generic deploy-force, gate-disable, rollback, migration,
> worker, or cron commands in this runbook do not grant production authorization
> and cannot override that NO-GO. Until the ordered recovery proof is complete
> and the owner explicitly records GO, do not open Beta, restore write workers or
> the paused host backup jobs, or perform an unprotected deployment. The local
> candidate fixes every GitHub backup/sentinel job false, and all 16 repository
> workflows are also `disabled_manually` in GitHub's control plane; non-completed
> runs are zero and only Dependabot's dynamic workflow remains active. Recovery
> migrations may run only through the ADR-023 channel and the exact sequence below.
> Both ingest workers are stopped. The Mac mini and SG primary incident holds,
> plus their compatibility guards, are armed as documented in
> `INGEST_WORKER_DEPLOY.md`; direct PM2 start/restart is prohibited. Generic
> Vercel Preview/Development high-sensitive inheritance is zero, all four old
> protection bypasses are revoked, Git integration is disconnected, and no build
> is queued. The exact staging-branch Supabase override is not yet proved
> disposable, so it is not an authorized staging target.
> The local candidate additionally fixes thirteen privileged production
> workflows and two CI production-secret jobs to zero runners. GitHub Free private
> repository policy still rejects main protection/rulesets and required reviewers;
> do not restore any workflow or release until governance is upgraded or an
> equivalent auditable source-trust/reviewer boundary is proved.

## Table of Contents

- [Pipeline Failure Troubleshooting](#pipeline-failure-troubleshooting)
- [Leaderboard Anomaly Troubleshooting](#leaderboard-anomaly-troubleshooting)
- [Telegram Alert Response](#telegram-alert-response)
- [Manual Ingest Canary](#manual-ingest-canary)
- [Manual Leaderboard Recompute](#manual-leaderboard-recompute)
- [Arena Score Recalculation](#arena-score-recalculation)
- [Deployment Rollback](#deployment-rollback)
- [Database Emergency Operations](#database-emergency-operations)
- [Trader claim V2 two-phase cutover](#trader-claim-v2-two-phase-cutover)
- [Common Errors and Solutions](#common-errors-and-solutions)
- [Supabase Outage](#supabase-outage)
- [Key Infrastructure](#key-infrastructure)

---

## Pipeline Failure Troubleshooting

### Symptom: Platform has no fresh data

1. **Diagnose** which platform is stale:

   ```bash
   node scripts/pipeline-health-check.mjs
   # or quick mode:
   node scripts/pipeline-health-check.mjs --quick
   ```

2. **Check pipeline logs** for the failing job:

   ```bash
   npx tsx scripts/pipeline-report.ts
   ```

3. **Check Vercel function logs** for errors:

   ```bash
   vercel logs --since 2h
   ```

4. **Common causes and fixes**:

   | Cause                       | Fix                                                                   |
   | --------------------------- | --------------------------------------------------------------------- |
   | Exchange API changed format | Update the fetcher/connector to match new response shape              |
   | VPS scraper down            | SSH to VPS, check PM2: `pm2 status`, `pm2 restart arena-scraper`      |
   | Rate limited (429)          | Wait for cooldown or increase delay in connector config               |
   | Geo-blocked                 | Route through VPS proxy or Cloudflare Worker                          |
   | Timeout (524/504)           | Reduce batch size or increase `timeoutMs` in connector config         |
   | Supabase error 42P10        | Missing unique constraint on target table -- check ON CONFLICT clause |

5. **Generate automated fix script**:
   ```bash
   node scripts/pipeline-health-check.mjs --fix
   ```

### Symptom: Cron job stuck in "running" status

```sql
-- Find stuck jobs (running > 10 minutes)
UPDATE pipeline_logs
SET status = 'error',
    error_message = 'Force-closed: stuck job',
    ended_at = NOW()
WHERE status = 'running' AND started_at < NOW() - INTERVAL '10 minutes';
```

---

## Leaderboard Anomaly Troubleshooting

### Symptom: Trader with impossibly high ROI

1. Check the serving row and its source-data watermark:

   ```sql
   SELECT
     source,
     source_trader_id,
     season_id,
     roi,
     pnl,
     arena_score,
     is_outlier,
     source_as_of,
     computed_at
   FROM leaderboard_ranks
   WHERE source_trader_id = '<trader_key>'
   ORDER BY season_id, computed_at DESC;
   ```

2. Trace the exact PASSED board evidence that fed serving:

   ```sql
   SELECT
     source.slug,
     trader.exchange_trader_id,
     snapshot.timeframe,
     snapshot.scraped_at,
     snapshot.count_check_passed,
     snapshot.raw_object_id,
     entry.rank,
     entry.headline_roi,
     entry.headline_pnl,
     entry.raw
   FROM arena.traders AS trader
   JOIN arena.sources AS source ON source.id = trader.source_id
   JOIN arena.leaderboard_entries AS entry ON entry.trader_id = trader.id
   JOIN arena.leaderboard_snapshots AS snapshot
     ON snapshot.id = entry.snapshot_id
    AND snapshot.scraped_at = entry.scraped_at
   WHERE trader.exchange_trader_id = '<trader_key>'
   ORDER BY snapshot.scraped_at DESC
   LIMIT 20;
   ```

3. `compute-leaderboard` marks deterministic ROI/PnL corruption as
   `leaderboard_ranks.is_outlier`; public ranking reads exclude those rows.
   Do not hand-edit evidence or the derived rank row. Fix the adapter/parser or
   source normalization, publish a new count-check-PASSED snapshot, then
   recompute the affected season. If the whole source is unsafe, move it out of
   serving through the reviewed registry control rather than deleting rows.

### Symptom: Leaderboard shows stale data

1. Read the shared authority without firing pager side effects:

   ```bash
   curl -sS \
     -H "Authorization: Bearer $CRON_SECRET" \
     "https://www.arenafi.org/api/admin/data-freshness" | jq
   ```

   `unknown` means the registry/visible/watermark closure is broken; `stale` or
   `critical` means the authority is available and the upstream watermark is
   genuinely old. Do not call `/api/cron/check-data-freshness` just to inspect
   state: that endpoint intentionally triggers real alerts.

2. Inspect each published source watermark and the last successful monitor run:

   ```sql
   -- Independent registry promises. This service-role-only RPC must not be
   -- replaced by current rank counts.
   SELECT *
   FROM arena_freshness_expected_sources()
   ORDER BY season_id, filter_source, registry_slug;

   -- Current positive-count boards exposed by public navigation.
   SELECT '7D' AS season_id, visible.*
   FROM arena_visible_sources('7D') AS visible
   UNION ALL
   SELECT '30D' AS season_id, visible.*
   FROM arena_visible_sources('30D') AS visible
   UNION ALL
   SELECT '90D' AS season_id, visible.*
   FROM arena_visible_sources('90D') AS visible;

   SELECT
     season_id,
     source,
     source_as_of,
     recorded_at,
     round(extract(epoch FROM (now() - source_as_of)) / 3600.0, 1) AS age_hours
   FROM leaderboard_source_freshness
   ORDER BY source_as_of ASC, season_id, source;

   SELECT job_name, status, started_at, ended_at, metadata
   FROM pipeline_logs
   WHERE job_name = 'check-data-freshness'
   ORDER BY started_at DESC
   LIMIT 5;
   ```

3. Distinguish upstream staleness from publish lag:

   ```sql
   SELECT
     source.slug AS registry_slug,
     coalesce(
       nullif(btrim(source.meta->>'legacy_platform'), ''),
       source.slug
     ) AS public_source,
     snapshot.timeframe,
     max(snapshot.scraped_at) FILTER (WHERE snapshot.count_check_passed)
       AS latest_passed_source_at
   FROM arena.sources AS source
   LEFT JOIN arena.leaderboard_snapshots AS snapshot
     ON snapshot.source_id = source.id
    AND snapshot.timeframe IN (7, 30, 90)
   WHERE source.status = 'active'
     AND source.serving_mode = 'serving'
     AND btrim(coalesce(source.meta->>'legacy_platform', '')) <> 'null'
   GROUP BY source.slug, source.meta, snapshot.timeframe
   ORDER BY latest_passed_source_at ASC NULLS FIRST, source.slug;
   ```

   - Old/missing PASSED snapshot: fix that source's worker, adapter, route,
     credentials, or upstream availability first.
   - Fresh PASSED snapshot but old `source_as_of`: inspect the complete
     leaderboard publish and its freshness upsert.
   - Only after fresh upstream data exists should you trigger
     [Manual Leaderboard Recompute](#manual-leaderboard-recompute).

Never update `source_as_of` manually and never substitute
`leaderboard_ranks.computed_at` or `now()`. A score recompute over unchanged
snapshots is not a data refresh.

### Symptom: Duplicate traders in rankings

- `arena.traders` enforces uniqueness on `(source_id, exchange_trader_id)`.
- The serving compute lowercases `0x` identities before deduplicating on
  `(public source, source_trader_id)`.
- If duplicates appear, compare registry aliases and upstream identity
  canonicalization before attempting a data delete; two physical sources may
  intentionally map to one public source.

---

## Telegram Alert Response

Alerts are sent via `lib/alerts/send-alert.ts`. Warnings are buffered for the
digest path; critical alerts send immediately and use shared cooldown plus
delivery deduplication.

> **Current incident:** the Vercel Production `TELEGRAM_BOT_TOKEN` record has
> been removed and the old token returned 401. Telegram alerting is unavailable
> until the owner obtains a new BotFather token, installs it through the atomic
> provider procedure below, and proves a real delivery. A test that merely
> reaches the alert branch is not a successful alert test.

| Alert Level | Action                                                                      |
| ----------- | --------------------------------------------------------------------------- |
| `info`      | No action needed, informational                                             |
| `warning`   | Monitor -- check within 1 hour. Examples: 0 results returned, slow response |
| `critical`  | Act immediately. Examples: 3+ consecutive failures, database unreachable    |

### Common alert patterns

- **"<platform> consecutive failures 3+"**: Check platform API status, VPS proxy, and connector logs.
- **"<platform> returned 0 results"**: API may have changed or be temporarily down. Wait 1 cycle, then investigate.
- **"<platform> slow response"**: Check if the exchange is under maintenance or if VPS is overloaded.

---

## Manual Ingest Canary

The retired `unified-connector`, `batch-fetch-traders`, and `batch-enrich` HTTP
routes must not be used. First-party collection is owned by the region-affine
BullMQ ingest workers.

1. Read the source's authoritative execution region:

   ```sql
   SELECT slug, status, serving_mode, fetch_region
   FROM arena.sources
   WHERE slug = 'binance_spot';
   ```

2. From an operator checkout with `worker/.env`, enqueue one fail-fast Tier-A
   canary using the exact `fetch_region` returned above:

   ```bash
   npx tsx scripts/ingest-enqueue-region-smoke.mts binance_spot vps_sg
   ```

3. Watch the region worker and verify a new RAW capture, a count-check-PASSED
   leaderboard snapshot, and only then a serving publish. The canary enqueues
   real work and is not a dry run.

Never move a job to a different region merely to make the canary pass. See
`docs/INGEST_WORKER_TOPOLOGY.md` for node ownership, deploy paths, and heartbeat
verification.

---

## Manual Leaderboard Recompute

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/compute-leaderboard?season=90D"
```

This recomputes one serving season from the configured `COMPUTE_READ_SOURCE` and
writes `leaderboard_ranks`. It does not fetch upstream data and must not be used
to advance `leaderboard_source_freshness.source_as_of`.

The Mac Mini BullMQ worker normally schedules each season every 2 hours, staggered
by 5 minutes. Vercel's `compute-leaderboard-watchdog` checks twice per hour and
only intervenes when a season's serving compute is more than 3 hours old.

---

## Arena Score Recalculation

The serving leaderboard uses Arena Score v4:

- quality weights: PnL 0.30, ROI percentile 0.20, inverse-drawdown percentile
  0.20, Sharpe percentile 0.20, consistency 0.10;
- consistency combines available win-rate and profit-factor percentiles;
- sample size and optional-metric completeness produce a confidence discount;
- the displayed score blends the confidence-adjusted cohort percentile (0.70)
  with relative composite magnitude (0.30).

The older ROI+PnL score remains in `arena_score_v3` as a rollback value; it is
not the flagship `arena_score`.

To force recalculation:

1. Trigger `compute-leaderboard` (see above).
2. For composite scores, also trigger:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://www.arenafi.org/api/cron/precompute-composite"
   ```

Sources: `lib/utils/arena-score.ts`,
`app/api/cron/compute-leaderboard/score-traders.ts`

---

## Restore from R2 backup (灾难恢复)

> 2026-07-11:此前只备不演练、且无 restore 脚本/runbook(SLO.md 自承"每季度
> 演练一次")。备份侧已静默坏过两次(PM-20260702/20260703),恢复侧从未验证。
> 现有脚本 `scripts/maintenance/restore-from-r2.mjs`。
>
> **历史快照（2026-07-17，已被 2026-08-04 审计取代）**：`db push --dry-run`
> 曾报告 252 remote-only + 34 local-only。当时的“生产 schema 健康”结论不再有效；
> 仓库历史不能 fresh replay，灾备重建禁止
> 使用裸 `db push` 或 `migration repair --status reverted`。
>
> **2026-08-03 恢复审计**：当前 R2 产物与 restore 行为测试只能证明文件/传输
> 契约，不能证明 managed Supabase 可恢复。`arena+public` plain dump 会包含
> `CREATE SCHEMA public`，fresh PostgreSQL/Supabase 已有 `public`；直接加入 `-n auth`
> 还会与平台管理的 auth DDL/owner 冲突。因此本节当前是取证与恢复开发 runbook，
> 不是已验收的灾备按钮。
>
> **2026-08-03 incident evidence**：07-27、07-28、07-30、07-31、08-01、
> 08-02、08-03 共 7 个对象都是 20-byte gzip 空对象。07-26 legacy 候选虽通过
> 完整 gzip/SQL 流检查，但没有 `leaderboard_ranks`/partition COPY 数据，不能通过
> 当前关键表正数门禁，也尚未证明 exact PG17 legacy restrict/unrestrict 尾。保留
> 该候选作证据，但不得把它称为可恢复点。新的恢复演练应使用至少约 100 GiB
> 可用空间的 managed scratch 与事故恢复后生成、带当前 completion metadata 的
> 新备份。

**备份是什么**：`backup-to-r2.mjs` 设计为每日 dump `-n arena -n public`（PLAIN SQL，
`--no-owner --no-privileges`）→ gzip → multipart upload → 条件 HEAD 验证，写入
`db-backups/YYYY/MM/arena-backup-<UTC毫秒>-<run-id>-schemas.sql.gz`（schema 产物
保留 14 天）。current NO-GO 下所有 backup schedule 均保持暂停；“设计为每日”不代表
任务当前正在运行。这是**应用数据备份**，不含 `auth`/`storage`；用户身份当前只有
Supabase 托管 PITR，R2 没有已验证的独立恢复副本。

生产器使用独占的 `0700` 临时目录和 `0600`/`O_EXCL`/`O_NOFOLLOW` 文件；完整流
验证、SHA-256 与 multipart upload 必须绑定同一 sealed artifact。multipart 完成后，
以 upload ETag 对 exact immutable key 执行 `If-Match` 条件 HEAD，并核验 size、ETag、
`application/gzip`、完整模式/completion metadata、filename/key/`backup-date` identity，
以及 expected `artifact-size`、`artifact-sha256`、`recovery-scope`、`auth-coverage`、
`target-model=unproven`、`recovery-certified=false` metadata；任一失败都不得进入
retention prune。

新鲜度检查的 LIST 只用于选择最新 contract-shaped key，健康只以该 exact HEAD 与契约
绑定的 `backup-date` 为准；最新对象 invalid、stale 或 future 时必须 fail closed，禁止
回退旧对象报绿。freshness/restore shared object contract 不重新下载远端 body 计算
SHA-256；因此该检查通过只证明 capture artifact 新鲜且对象契约有效，不是远端 body
digest 重算，也不代表 managed auth recovery 已验收。

**列出对象清单**（只读，只验证凭据；清单出现不等于对象可恢复）：

```bash
node scripts/maintenance/restore-from-r2.mjs --list
```

**当前禁止把 `node scripts/maintenance/restore-from-r2.mjs` 的本地行为测试或一次
`psql` 退出 0 记为恢复演练通过。** 合格演练必须在隔离的 managed scratch 项目，
从既有平台 catalog 开始，验证 schema、auth 持久数据、应用数据、FK/RLS/grants、
登录与三张关键业务表；并记录真实 RPO/RTO。该演练尚无通过证据。

**真灾难时(Supabase 项目本身出事)**:

1. 先看 Supabase PITR 是否可用(付费档,恢复 auth+全库,首选,`--nuclear` 见下)。
2. PITR 也没了 → 当前没有一键全恢复路径。先升级事故；R2 应用数据只能在
   **已独立验证的 canonical baseline**与目标 catalog 兼容检查通过后受控提取，
   不得把历史目录临时 `db push` 或一次 plain SQL 导入伪装成可恢复方案。
3. auth 用户当前无 R2 副本；PITR 彻底丢失会要求重新注册。修复方向是同一 MVCC
   snapshot 下生成 auth **data-only sidecar**（排除平台迁移/session/token 表）并用
   manifest 与应用 dump 配对；不要把 `-n auth` 直接塞进现有 plain dump。

canonical baseline 与 auth sidecar 必须在独立维护波次中实现，并在 managed
scratch 项目完成 catalog 指纹、身份/应用数据、权限、RLS、登录和
`npm run qa:schema` 演练后，才能把恢复步骤重新写入本 runbook。

**脚本安全**：`RESTORE_TARGET_URL == DATABASE_URL`（生产）时硬拒绝，除非
`--force-prod`（几乎永远不该用）。缺少 `DATABASE_URL` 生产身份基准时默认硬拒绝；
只有已独立证明 scratch 隔离后才可显式传 `--allow-unverified-target`。这些参数只是目标
身份 guard；当前 CLI 在 guard 后仍无条件返回 `AUTOMATED RESTORE DISABLED`，
`--force-prod` 与 `--allow-unverified-target` 都不会重新启用 apply。

## Deployment Rollback

### 部署管线（2026-07-02 起：CI 门禁部署）

以下是历史正常流程，不是当前授权：push → CI（`ci.yml`）→ 4 个门禁作业
（Pre-flight / Lint & Type / Unit / Build）全绿 → `deploy-gate.yml` 用 Vercel
CLI 部署 → 内嵌 smoke（5 URL）→ 失败自动 promote 回滚 + Telegram。当前本地
候选已把 `deploy-gate`、`post-deploy-smoke` 与 `post-deploy-evaluate` 全部固定为
`if: false`；CI 的 production drift/data jobs 同样暂停。线上 16 个 repository
workflow 也已在 GitHub 控制面全部手工停用，non-completed run 为零；Dependabot
dynamic workflow 仍 active。
跳过逻辑内联在 `vercel.json` 的 `ignoreCommand`（不要改成依赖 scripts/ 下的
文件——.vercelignore 目录级排除无法负向穿透，会 ENOENT 把全部部署打成 ERROR）。
E2E 被更新 push 折叠取消不影响门禁；CI 红则扣留部署并 Telegram 告警。
Vercel Git integration 当前已断开，generic Preview/Development 高权限变量与旧
bypass 均已清零，因此 push 不会自动构建或发布；但精确 staging 分支 override
是否指向 disposable 非生产项目尚未证明。旧 `docs/STAGING.md` 继续被本事故门禁暂停。

> **Incident restriction:** current NO-GO 期间禁止使用 deploy-force 标记或
> 关闭 `ignoreCommand`/deploy gate。它们是历史 break-glass 机制，不是绕过事故停止线的授权。

- **历史紧急逃生口（当前禁用）**：commit message 含 `[deploy-force]` 曾会跳过
  CI 门禁直接构建并依赖 post-deploy smoke；当前 NO-GO 下该 smoke 也固定零 runner，
  因而该路径既未授权也没有安全兜底。
  ⚠️ 匹配的是**完整 commit message 含正文**——不要在普通提交的说明文字里
  字面写出这个标记（2026-07-02 实测：一条讨论该标记的 commit 正文触发了
  直接部署）。文档里提及时用「deploy-force 标记」这类改写。
- **正常延迟**：生产部署滞后 push 约 8-12 分钟（CI 时长）。
- **部署判定 = ancestry**：gate 部署"CI 绿且比当前线上更新"的 SHA
  （`git merge-base --is-ancestor` 判祖先，旧 SHA 迟到直接拒绝，杜绝回退）。
  线上 SHA 经 `vercel deploy --meta gateSha=<sha>` 写入、下轮读回核对。
  连续推送爆发期里生产会跳到**最新已验证**的那个 commit，不会饿死落后
  （早期"只部署恰好 HEAD"的版本实测连续 4 轮 superseded，已废弃）。
  gate 的 concurrency 是**排队不取消**：杀死部署中的 run 无法撤销已上传
  构建，反而可能晚到抢占生产别名造成回退。
- **历史门禁停用机制（current NO-GO 禁止）**：旧流程可通过 revert
  `vercel.json` 的 `ignoreCommand` 恢复直接部署；事故期间不得执行，也不能作为
  break-glass 授权。
- **自动回滚 API**：唯一真实端点是
  `POST https://api.vercel.com/v10/projects/{projectId}/promote/{deploymentId}`
  （旧 `/v6/deployments/{id}/promote` 是 404，2026-07-02 实测修正）。

### Manual/provider-atomic secret rotation

`scripts/security/rotate-secrets.sh` 已退役并固定以退出码 `2` fail closed。它不再读取、
生成、记录或修改任何凭据。不同 provider 的双 key、版本、激活和撤销语义不同；禁止用一个
通用脚本执行 Vercel `env rm` 后 `env add`、把 secret 放进 CLI argv、回显到终端，
或写入仓库根 `.env`、`.env.bak`、rotation log 和带时间戳的明文备份。

每次轮换必须由 credential owner 在 provider 控制面执行，并为**该凭据**先建立完整 consumer
manifest。至少逐项裁定：provider 本身、Vercel Production，以及仅在明确授权时的
Preview/Development；GitHub organization/repository/Environment secrets；Mac mini 与 SG
worker 的受保护 host env；webhook/cron/monitoring 配置；获准的本地运行环境；以及需要重新
部署或重启才会加载新值的 exact release。consumer 未穷尽时维持 NO-GO。

支持重叠凭据、双 key 或 version alias 的 provider 使用以下顺序：

1. 冻结相关 deploy/writer，记录 owner、credential ID、允许的 scope、consumer manifest、
   轮换窗口和回退负责人；只记录 ID 或不可逆指纹，不记录 secret 原文。
2. 在 provider 内创建新版本，但保留旧版本有效。通过 provider 的受保护 UI，或经独立证明
   不把值放入 argv/log 的安全输入通道，把新版本写到 manifest 中的每个 secret store。
3. 原子选择/替换 consumer 当前版本；不得先删除仍在服务的旧值。按 exact SHA 重新部署或
   重启所有需要 reload 的 consumer，并逐个证明它们加载的是新 credential ID/版本。
4. 用最小权限 canary 证明新值成功；保留状态码、时间、consumer、credential ID/指纹和
   exact release 证据，不保留请求头、连接串或 token。
5. 只有 manifest 全部通过后才在 provider 撤销旧版本。随后用无敏感输出的 negative canary
   证明旧 credential 明确失败，并再次证明新版本和所有消费者健康。

只支持单一活动值、无法重叠的 provider 必须使用其文档化的 provider-native atomic rotate/
activate 操作和维护窗口：先让全部消费者进入安全停写/停服状态，再协调 provider 旋转、
secret-store 替换、reload 与 canary。若 provider 或任一 consumer 不能在同一受控窗口内
原子切换，停止轮换并维持 NO-GO；不得退化成 delete-then-add。

任何阶段若新值验证失败，先保持旧值有效并回退 consumer 选择；若 provider 已使旧值失效，
保持服务 fail closed，按 provider 恢复流程处理，禁止从终端历史、日志或明文备份“找回”。
current incident NO-GO 期间，本节只定义 owner 操作门禁，不授权部署、secret 写入或轮换执行。

当前 GitHub 控制面已删除 10 个 repository 高敏 secrets，剩余仅公开/配置标识；
`Production`、`arena-staging-payment-canary` 与 `ingest-sg-production` environment
均只允许 exact `main`。这些动作不证明旧 provider 值已撤销，也不证明高敏值已迁入
environment。当前计划无法配置 required reviewer 或 protected `main`，所以 16 个
repository workflow 必须继续保持 disabled；Dependabot dynamic workflow 仍 active。

### Vercel Deployment Protection bypass 轮换门禁

Deployment Protection bypass credential 与 deploy-force 标记是两个不同的能力，两者都不能覆盖 current incident NO-GO。本次发布前必须完成：

当前项目 `protectionBypass={}`，4 个旧 automation/manual credentials 已全部撤销，
count 为 `0`。在 protected source/reviewer 能力不可用期间必须保持为零。

1. `DONE`：撤销所有旧 automation/manual deployment-protection bypass credentials。
2. `BLOCKED`：不要重新签发。只有受保护自动化来源、required reviewer 与最小 consumer manifest 均已证明后，才可评审是否需要一枚新 secret；不得复制到个人终端、issue、日志或报告。
3. 对每个旧值访问 generated deployment URL，保留其返回保护页/401/其他明确失败的证据。当前只有一个旧值具备 HTTP 失败证明，其余三个只有项目 map 归零证明，二者不得混写。
4. 若未来获准新签，证明新值仅在受保护 workflow 内完成获准 smoke。只记录 credential ID/指纹、owner、轮换时间和测试结果，不记录 secret 原文。

旧值仍能访问、新值出现在非受控环境，或无法绑定轮换证据时，发布维持 NO-GO。

### V1 完整十六迁移数据库门禁（待执行 / 待证明）

本节与下方“排名权威数据库先行门禁”共同构成一条门禁，不是生产执行记录，也不是十六个文件连续批量应用的授权。任何 ranking 数据库写入前，必须先用独立 edge deny 或从 production exact SHA 派生的最小 fail-closed hotfix 关闭全部 token API/页面并留下 HTTP negative proof；当前整分支包含 schema-coupled 变更，不能拿它冒充该最小止损包。随后冻结完整 predeploy ordered baseline，逐项裁决全部 `51` 个缺项与 ledger drift；四个 ranking-authority 文件本身属于这 `51` 项，只有抵达各自在 manifest 中的位置且所有前序 exact 时，才按固定顺序逐文件补齐。五个额外身份/凭据安全前置 `20260716093000_user_linked_traders_server_write_only.sql`、`20260716112000_exchange_connections_server_only.sql`、`20260716178000_user_profile_write_authority.sql`、`20260716179100_user_profile_read_audience.sql`、`20260716179200_user_profile_wallet_authority.sql` 也须同时证明。四个 ranking 文件 exact 后，在同一维护窗口立即单独执行 token-ranking retirement，再依次执行 record provenance clocks → publication substrate → verified position-history writer → activation → 受保护部署 exact RAW-only/fail-closed bridge SHA 并排空所有 legacy position-history calls/transactions → legacy relation freeze → legacy writer retirement → records-page quarantine → 排空 legacy Tier-A writer/queue 后单独补 missing postdeploy → authorization → legacy Portfolio retirement → Claim Phase A → 使用同一 SHA 成功 smoke → Claim Phase B。这些安全前置和 Tier-A postdeploy 不计入十六个核心产品 migration，但任一未证明即维持 NO-GO。

2026-08-04 02:24Z 的显式 `READ ONLY` production 审计已证明：完整 predeploy manifest 为 `114` 中 `63 exact / 51 missing`；四个 ranking-authority migration 及三个直接前序依赖均 ledger missing + live fail。三个 record/publication 基础 migration 均 ledger/live missing，且 `20260803090000` 要求的 records/copier RPC 哈希与生产现状不匹配。postdeploy `3` 中 `2 exact / 1 missing`；缺项为 `20260729061000_tier_a_execution_claim_enforcement.sql`，live marker 也不存在。五个身份/凭据 ACL 前置中四个 exact + live pass；`20260716093000` 的 name/body/created_by 与 live ACL 正确，但 idempotency key drift，是明确 ledger/live 冲突。五个较晚的 2026-08 migration 也全部 ledger missing + live fail。05:55Z 的第二次显式 `READ ONLY` 复核确认 `20260804041000` 与 `20260804042000` ledger missing、live retirement/quarantine fail；06:30Z 的第三次复核确认 `20260804043000_retire_legacy_token_rankings.sql` ledger/head/head reader/v2 reader 均不存在，旧 refresh 函数仍存在且 body 尚未退役。随后主干新增 `20260804044000_freeze_legacy_position_history_relations.sql`；它晚于上述快照且没有任何 apply 证据，所以按 fail-closed 证据口径计为第 `64` 个 gap，production exact ledger/live catalog 仍须再次只读核验，不能把“无 apply 证据”写成已完成 live postflight。production 也不具备 `040430` 的 generation-barrier 前态；不得直接补四个 ranking 文件、跳过 token-ranking retirement、把六个 record/publication/retirement/freeze 文件批量重放、手改 ledger 或跳过 drift。先冻结完整 ordered baseline，为每个缺项建立依赖/重放安全证据和 ADR-023 单文件记录。transaction pooler 只用于本次取证，不是 migration writer；`5432 + verify-full` session 通道仍须另证。

以下十二个 2026-08 核心 migration 与四个 2026-07 ranking-authority migration 合计
十六个核心 migration。目前它们只有仓库代码和隔离测试能力，尚未在 staging 或
production 获得完整 apply 证据；这是 inventory，不是 apply 顺序，各项最终 pass 仍须
绑定同一个 exact candidate SHA：

1. `20260803090000_record_provenance_clocks.sql`
2. `20260803100000_record_surface_publication_substrate.sql`
3. `20260803101000_verified_position_history_publication_writer.sql`
4. `20260803211000_b2c_activation_v2.sql`
5. `20260803211500_trader_authorizations_server_only.sql`
6. `20260803212000_legacy_portfolios_v1_retirement.sql`
7. `20260803213000_trader_claim_v2_rpcs.sql`（Claim Phase A）
8. `20260803214000_trader_claim_v2_cutover.sql`（Claim Phase B）
9. `20260804041000_retire_legacy_position_history_publisher.sql`
10. `20260804042000_fail_closed_position_history_records_page.sql`
11. `20260804043000_retire_legacy_token_rankings.sql`
12. `20260804044000_freeze_legacy_position_history_relations.sql`

必须使用以下有序流程：

0. 当前 legacy token-ranking surface 是 **ACTIVE-EXPOSURE**；最新公开只读探针、缓存
   状态与 production deployment 证据统一以
   [`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md) 为准。
   任何 predeploy/ranking migration 前，custom domain 与全部别名上的
   `/api/rankings/by-token` detail/popular 请求必须固定 fail closed，
   `/rankings/tokens` 与 `/rankings/tokens/*` 不得渲染或请求旧排名；响应必须不可缓存，
   且日志/测试证明零 Supabase/Redis 调用。优先使用获准、可回滚且覆盖所有别名的 edge
   deny；若用代码，只能从 production exact SHA 建立 allowlist 极小的独立 hotfix。该负向
   门禁从第一项 ranking migration 前持续到 `040430` exact proof；未完成即数据库零写入。
1. 冻结全部 `51` 个 predeploy 缺项的 ordered baseline，为每项建立依赖/重放安全证据并裁决 `20260716093000` drift。四个 ranking 文件就是这 `51` 项中的四项，不是“其余 51 项全部完成后的额外批次”；只有 manifest 中位于目标文件之前的每一项 exact、目标确认缺失且 live catalog 与迁移前契约兼容时，才在抵达其位置后按四文件固定顺序逐文件补齐。全部 `51` 项最终 exact 前，predeploy 门禁仍未闭合，也不开始后续 2026-08 数据库变更。
2. 在任何 2026-08 migration 前，用 production exact ledger 与 live ACL catalog 同时证明五个额外安全前置。`20260716093000` 必须令 `user_linked_traders` 对 browser/PUBLIC 无 DML、authenticated 仅 own SELECT、service role CRUD 且 policy 精确收敛；`20260716112000` 必须令 `user_exchange_connections` 对 browser/PUBLIC 无 table/column 路径、service CRUD 且只有精确 service policy；`20260716178000`/`179100`/`179200` 必须共同保护 profile 写入/读取/钱包权威，尤其 authenticated 不可更新 `is_verified_trader`、`verified_trader_id`、`verified_trader_source`、`linked_trader_count`。仅当只读检查确认某 ledger 缺失、live catalog 仍与迁移前基线兼容时，才按时间顺序通过 ADR-023 获准单文件通道补齐并重复 ACL 证明；ledger/catalog 冲突时停止，不修 ledger、不盲目重放。这五个文件不计入十六个核心产品 migration。
3. 四个 ranking-authority migration 均 exact 后，经 ADR-023 单文件应用 `20260804043000_retire_legacy_token_rankings.sql`。它必须以 publication-head `FOR UPDATE NOWAIT` 证明没有在途 refresh，并精确匹配 generation-barrier 前态；随后证明 durable/RPC head 为 generation zero + unpublished、exact cron identity 保留但 inactive、七个函数和两个 MV OID/内容保留、除 service-only head getter 外 reader/writer 与所有非 owner MV ACL 均返回精确 fail-closed 状态，且重放 byte-stable。当前 production 缺少 head/generation barrier，不是可执行前态；任何 prerequisite、hash、overload、ACL、在途 refresh 或 ledger/live drift 都停止。
4. 完整 predeploy/ranking/retirement baseline 与 `20260803090000` 现有函数哈希漂移经独立审查闭合后，在受保护 staging 按 `20260803090000` → `20260803100000` → `20260803101000` 逐文件应用 record/publication 基础链。逐项证明 record provenance/observation/publication clocks、private immutable publication chain、`position_history.verified_publication_id` 绑定、checkpoint/chain-health RPC，以及由同一原子 writer 产生的 verified publication receipt。position-history artifact `@2` 可持久化，并可在 advisory lock、RAW pointer row lock 与重新验证下重放 acquisition/source facts；目前没有 production projection consumer，也没有 parser/rank receipt。在 `040410` 之前旧 writer 只可作为短暂迁移 substrate，候选 app/worker 不得再调用；无 parser-conservation receipt-bound projection 前不得重开。任何 preflight、ACL、链完整性、artifact 版本混用或 ledger/live drift 都停止。
5. 在受保护 staging 单文件通道应用 activation migration，证明 epoch 行、v2 RPC、`service_role` 只读指标契约和旧事件解析兼容。
6. 在 authorization、Portfolio retirement 与 Claim Phase A 尚未应用时，通过受保护发布管线部署候选 exact RAW-only/fail-closed bridge SHA。证明旧 connect、bind、sync 与 OAuth 入口无条件固定 410；两个 auth-first tombstone `/api/exchange/verify-ownership` 和 `/api/traders/claim/verify-wallet` 必须分别为匿名 401、已登录 410，且没有凭据读取、proof consumption 或 direct-table fallback。另证明新的 authorize POST/Claim 写路径因 RPC 缺失而 fail closed，旧 Portfolio 四入口固定 410，snapshot cron 为认证 no-op 且未调度；Portfolio export RPC 尚不存在时，已认证 export 必须返回 500。保留的 EVM address portfolio/suggestions 不属于旧凭据面。还必须证明 app/worker 不再调用 legacy position-history publisher，records 层在 PostgREST 前短路且 Tier-C position acquisition 不读取 legacy cursor，maintenance partition/prune 不再包含 `position_history`，data bridge、API、warm cache 与 UI 均不再暴露 legacy history；隔离测试须断言旧 RPC/cursor/maintenance 零调用。保持两台 writer 停止，排空所有 legacy publisher、reader、maintenance partition/prune 调用及已进入事务；记录 exact SHA，到 Phase B 后验证结束不得换包。
7. 保持该 exact bridge SHA 和 writer 停止；只有 web、cron、两台 worker、queue、分区创建器调用和已进入事务全部排空后，才经 ADR-023 先单文件应用 `20260804044000_freeze_legacy_position_history_relations.sql`。它必须保持所有旧 relation/OID/数据用于取证，只给 `service_role` 非 grantable SELECT，撤销所有 runtime DML/DDL 间接能力，安装无条件 I/U/D/TRUNCATE guard，并把 `create_next_tph_partition()` 固定为 retired stub；只读 postflight 的 `legacy_history_frozen` 必须为 true，不要用真实 production 写入试探。随后单文件应用 `20260804041000_retire_legacy_position_history_publisher.sql`，证明 arena writer OID、receipt chain 与 checkpoint reader 保留，但所有 application role 无 execute、typed INSERT/UPDATE fail closed、既有 cleanup 仍可用；最后单文件应用 `20260804042000_fail_closed_position_history_records_page.sql`，证明仅 `position_history` 返回 `rows=[]`、所有 clocks 为 null、`completeness.state=unknown`/`reason=history_evidence_not_bound`，其他 record kinds 保持原契约。三个 migration 在 schema 上无直接依赖，但先冻结仍对外直达的 public legacy relation 可缩短暴露并让复杂 topology preflight 先失败；`040440` 不得机械紧跟 `040430`，也不得先于 exact bridge 与全调用排空。任一排空、preflight、ACL、hash、ledger/live 或 PostgREST reload 证明失败都停止。
8. 继续保持 writer 停止，证明所有 legacy Tier-A worker/queue 已排空且完整 predeploy manifest exact，再通过 ADR-023 单文件应用 `20260729061000_tier_a_execution_claim_enforcement.sql`。核对 exact ledger、live marker、触发器、ACL、旧 unclaimed RPC 拒绝和 claimed worker 契约；它不计入十六个核心 migration。任何残留 writer/queue 或 catalog drift 都停止。
9. 保持该 bridge SHA，再应用 authorization migration。它的 preflight 必须拒绝未满足上述 exchange-connection ACL 的环境；迁移必须隔离 active legacy alias、OAuth 或缺少 attestation 的 connection，并撤销没有同用户、同 exact canonical exchange 与同 verified UID 的 active connection 支撑的 authorization。这些账户必须由用户显式 rebind，不得自动提升旧记录。随后证明两张凭据表对 browser roles/PUBLIC 均无 table/column 路径，bind/revoke 两个原子 RPC 均无 browser/PUBLIC execute 路径且仅 service role 可调用。在 disposable fixture 依次证明公开选择器只有 Binance、Bybit、Bitget；首次绑定同时写入两张投影；同一 canonical exchange 重绑撤销旧 active authorization；两种 revoke selector 都同时停用 connection 并撤销全部匹配 authorization；绑定或撤销任一投影失败时整条 RPC 原子回滚。最后运行只读反连接，结果必须为零：每条 active authorization 都必须有同用户、同 exact canonical exchange、同 verified UID 的 active connection。这个顺序有意不按文件时间排序。
10. 单独应用 Portfolio retirement。核对三表/cascade FK exact shape；browser/PUBLIC 零 table/column 权限；service 无直接 DML、无密文/positions/snapshots direct SELECT，仅有五个 metadata 列 SELECT；唯一 policy 为 service metadata read；`export_legacy_portfolio_data_v1(uuid)` 与 delete RPC 仅 service 可执行。行级 fixture 只在 staging 建立：证明 authenticated RPC deny、HTTP export 固定传认证 user id、迁移后返回 200，`account.legacy_portfolios` 与 manifest 完整包含 portfolios/positions/snapshots 三项及 fixture owner rows，字段精确白名单、无 user id/密文且 child 不越出 owner portfolio set；任一组超过 250,000 行必须返回 413，而不是截断或返回部分成功。同时覆盖跨 owner delete false、parent/child cascade、故障回滚、重放，以及迁移不删除 owner 行、不改写密文。production inventory 若仍为零，只验证 ACL/RPC 与完整空 manifest，不创建 disposable 行；若非零，才导出 owner/交易所 metadata 清单并要求 owner 下载、交易所侧 revoke/rotate 和 Arena 清理裁决。
11. Claim Phase A 前只读证明 migration role exact 拥有 `trader_claims`，再应用 Phase A。核对 typed submit/reject/cancel、guard、ledger/reload，并证明 legacy activation 与 Arena claimed helper 均不可执行。Phase A 没有批准能力，不是“可批准的向后兼容层”。
12. 使用同一 exact bridge SHA 完成 authorization 和 Hyperliquid/GMX challenge → submit → `reviewing` → reject/cancel smoke；legacy 与 V2 approval 此时都须 fail closed。所有 CEX claim 均 unsupported，CEX API key 不得创建 claim/badge。
13. Phase B 前只读证明 migration role exact 拥有 migration preflight 列出的全部 relation。只在同一 SHA 成功 smoke 后单独应用 Phase B，证明 legacy submit/direct DML fail closed、canonical `activate_trader_claim_v2` 管理员批准成功并原子更新 badge/link/profile/Arena，且 unlink 仅 service 可执行、任一步失败全部回滚。Phase A/B 不得批量连续应用。
14. staging 通过后 production 严格重复：先维持 token surface HTTP containment，再执行四项 ranking authority → token-ranking retirement → record provenance clocks → publication substrate → verified position-history writer → activation → exact RAW-only/fail-closed bridge SHA 并排空 legacy calls/transactions → legacy relation freeze → legacy writer retirement → records-page quarantine → legacy Tier-A 排空与单文件 postdeploy → authorization → Portfolio retirement → Claim Phase A → 同一 SHA 成功 smoke → Claim Phase B。每个文件单独提交并核对 exact ledger/live catalog/ACL/RPC/reload；不得用 `db push`、历史批量重放或禁用 writer 替代。
15. production 未获准时不创建 disposable claim 或 portfolio。Phase B 后 legacy application 不是有效回滚目标。
16. 只有五个额外 ACL 前置、missing Tier-A postdeploy 与全部十六个 production migration 的 exact proof、token-ranking 与 record publication/retirement/freeze、authorization、Portfolio 和 Claim 全生命周期 smoke 闭合后，才能从 production 运行 `npm run gen:types`。
17. 运行 migration history shape、前置与 2026-07 suites；`npm run qa:public-rank-authority-pg17` 必须覆盖 token-ranking retirement 的在途 refresh 回滚/排空重试、generation-zero head、reader/writer/MV ACL fail-closed、OID/MV 内容保持、cron identity 保持和 byte-stable replay。再运行三个 record/publication 基础 PG17 suite、`npm run qa:retire-legacy-position-history-pg17`、`npm run qa:records-page-quarantine-pg17`、`supabase/migrations/__tests__/legacy-position-history-partition-freeze.pg17.sh`，以及 activation、authorization、legacy-portfolio-retirement、claim-cutover 四项 PG17 suite（覆盖五个较晚的 2026-08 migration）。任何证据不完整即 NO-GO。
18. Phase B 后重新 inventory 历史 verified rows 与 legacy Portfolio key；零行记录 `zero / N/A`，只对非零行逐项审计身份投影或完成 revoke/rotate、联系与归属裁决。
19. 从 exact bridge 停止所有旧公开 first-party writer 起等待至少 48 小时，并只读证明没有 fresh `provenance='first_party'` 排名输入后，才可重算或开放 Beta。

### 排名权威数据库先行门禁（BLOCKED / 已取证）

以下步骤是完整十六迁移门禁的第一阶段，不是生产执行授权。当前 legacy token-ranking
surface 是 **ACTIVE-EXPOSURE**；最新 HTTP/cache 探针统一以
[`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md) 为准。
此前 production 只读数据库审计同时证明四个 ranking-authority migration 均为 ledger
missing + live fail，后继 token-ranking retirement 也 ledger/live missing；完整 predeploy
manifest 还有 47 个其他缺项，且 `20260716093000` 存在 idempotency ledger drift。结论是
**BLOCKED**；不得把“已确认五个 ranking 文件缺失”误解为可以直接补文件，更不得批量
重放或手改 ledger。

0. 在任何 ranking DB 写入前，先以获准 edge deny 或独立最小 hotfix 封闭 custom domain 与全部别名上的 token detail/popular API、index/detail 页面、导航和 sitemap 发现入口。API 必须固定 503（或经单独评审固定 410）、无 traders/tokens/total、`Cache-Control: private, no-store, max-age=0, must-revalidate`，页面不得挂载会 fetch 的 client；日志和测试必须证明零 Supabase/Redis 调用。发布后从两个网络点以不同 query 验证无旧 public cache，并绑定 exact deployment SHA。该门禁持续到 `040430` exact；通过前不应用任何 predeploy/ranking migration。
1. 在应用候选版本前，先冻结并复核完整 `114` 项 predeploy manifest、production ledger 与 live catalog 快照。对全部 `51` 个缺项逐个建立依赖、现有 catalog 兼容性与重放安全证据；对每个确需应用的文件建立 ADR-023 单文件记录。四个 ranking 文件属于这 `51` 项；`20260716093000` 的 name/body/creator 与 live ACL pass、idempotency key drift 必须单独裁决。任一目标文件的全部 manifest 前序或 drift 未闭合时，该文件及其后续所有写入均禁止执行。
2. 只有四个目标各自的完整 manifest 前序已闭合、`5432 + verify-full` 获准 migration writer 已证明、且每个文件的 ADR-023 审批齐全后，才可在 ordered manifest 抵达它们时严格按以下顺序逐文件提交；每次只提交一个完整文件并立即核对 exact ledger/live catalog，不得使用本地 `db push`、批量历史重放或脚本中已禁用的 psql 写命令：
   1. `20260729223000_rerank_public_eligible_rows_only.sql`
   2. `20260729224000_rank_eligible_leaderboard_count_cache.sql`
   3. `20260729225000_token_trader_rank_authority.sql`
   4. `20260729230000_token_ranking_generation_barrier.sql`
3. 第四个 migration exact 后，不调用 `refresh_popular_tokens_mv()`，不等待 cron 发布，不读取或展示 legacy/v2 token-ranking payload，也不要求 `generation_seq > 0`。这些数据缺少 frozen rank-eligible authority snapshot；生成一个新 generation 只会扩大不可信发布面，绝不是 `040430` 的前置。只通过获准 `READ ONLY` catalog 审计确认七个 callable、两个 populated MV、publication-head singleton、唯一 exact cron identity 与 predecessor body/ACL shape 均匹配，并确认当前没有 refresh 在途；最终并发屏障仍由 `040430` 的 `FOR UPDATE NOWAIT` 负责。四个 predecessor 与 retirement 必须安排在同一维护窗口，不能在两者之间开放 token 榜或留到下一次 cron 调度。
4. 前述只读 preflight 通过后，立即通过 ADR-023 单文件应用 `20260804043000_retire_legacy_token_rankings.sql`。若 publication-head 锁冲突，整事务失败，先排空 refresh 再重试；不得手动触发 refresh 作为“修复”。提交后核对 exact ledger、PostgREST reload、durable/RPC head 的 `generation_seq=0` 与其余时间字段为 NULL、两个 row count 为 0；核对 exact `refresh-mv-popular-tokens` cron job identity 保持且 `active=false`。七个函数和两个 MV 的 OID、MV definition/populated/content 必须保持；除 service-role head getter 外，六个关闭函数、两个 MV 的 table/column/delegated ACL 对全部 runtime role 均不可用，所有 retired reader/writer 探针返回精确 SQLSTATE `55000`。最后重放一次并证明 catalog/ACL/body hash byte-stable。只读 HTTP head 核验必须使用 `/rest/v1/rpc/get_token_ranking_publication_head` 并满足：

   ```bash
   TOKEN_HEAD_JSON="$(curl -fsS -X POST \
     "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/get_token_ranking_publication_head" \
     -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
     -H 'Content-Type: application/json' \
     -d '{}')"

   jq -e '
     type == "array" and length == 1
     and .[0].generation_seq == 0
     and .[0].published_at == null
     and .[0].published_at_epoch_ms == null
     and .[0].window_through_date == null
     and .[0].source_as_of == null
     and .[0].source_through_date == null
     and .[0].daily_row_count == 0
     and .[0].popular_row_count == 0
   ' <<<"$TOKEN_HEAD_JSON"
   ```

   同一 `READ ONLY` catalog 证明必须记录 `legacy_token_rpcs_closed=true` 与 `legacy_token_mvs_closed=true`。任一 prerequisite、overload、hash、ACL、OID、MV 内容、cron identity 或 replay 不符都停止。

5. `040430` 提交后的公开 smoke 必须在所有域名上保持 detail/popular API 为 HTTP 503、`TOKEN_RANKING_NOT_PUBLISHED`、`private, no-store`，Token 页面不渲染旧榜；不得重新打开前置 edge/hotfix containment。Token 榜只能由后续单独评审的 authority-snapshot migration 重新开放；新发布器必须从 `arena.token_trade_fact_authority_shadow` 的 `rank_eligible=true` frozen cohort 构建，绑定非 NULL source watermark，并证明 history、price、cost basis 与 FX 全部可信。
6. `040430` retirement exact proof 完成后，才允许进入 2026-08 record/publication/retirement/freeze → activation/authorization/Claim 门禁；后续候选版本的发布与 production smoke 必须遵守上方 token-ranking retirement → record provenance clocks → publication substrate → verified position-history writer → activation → exact RAW-only/fail-closed bridge SHA 并排空 legacy calls/transactions → `20260804044000_freeze_legacy_position_history_relations.sql` → legacy writer retirement → records-page quarantine → legacy Tier-A writer/queue 排空并单文件 postdeploy → authorization → Portfolio retirement → Phase A → 同一 SHA 成功 smoke → Phase B 顺序。
   第二个迁移会在同一事务中切换 legacy rerank wrapper、重排三个 season 并重建
   rank-derived count；第三个迁移是 token 榜 `token_rank` 应用契约的数据库先行
   条件；第四个迁移是跨页 generation read barrier；第五个核心 ranking migration
   将未绑定 authority snapshot 的旧 token publication 整体 fail closed。不得少应用
   其中任一迁移后发布应用。

### Vercel instant rollback

Current incident NO-GO 下不得直接运行本节命令或手工 promote；只有 owner 明确
授权并已证明回滚目标/数据库契约兼容时，才能通过受保护发布控制流程使用。

```bash
# List recent deployments
vercel ls

# Rollback to previous deployment
vercel rollback <deployment-url>
```

### Via Vercel dashboard

1. Go to https://vercel.com/team/ranking-arena/deployments
2. Find the last known-good deployment
3. Click "..." > "Promote to Production"

### Emergency: disable a cron job

If a cron job is causing issues, stop the exact external scheduler in its control
plane when possible and preserve evidence. A `vercel.json` change must go through
the protected PR/release workflow. During the current exact-staging-disposability
and source-trust NO-GO, do not push a branch merely to disable a cron; request an
owner-approved control-plane change instead. Vercel Git integration is currently
disconnected, so a push is neither an automatic deploy nor release authorization.

---

## Database Emergency Operations

### High connection count

```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Kill idle connections older than 5 minutes
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle' AND query_start < NOW() - INTERVAL '5 minutes';
```

### Slow queries

```sql
-- Find slow queries (running > 10 seconds)
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND (now() - pg_stat_activity.query_start) > INTERVAL '10 seconds'
ORDER BY duration DESC;

-- Kill a specific slow query
SELECT pg_cancel_backend(<pid>);
```

### Table bloat / VACUUM

```sql
-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;

-- Example for a current serving relation; confirm the target from the size
-- query before running this in production.
VACUUM (VERBOSE, ANALYZE) public.leaderboard_ranks;
```

**WARNING**: Never DELETE historical data (daily snapshots, equity curves, timeseries). These are retained for long-term analysis.

---

## Trader claim V2 two-phase cutover

The claim writer cutoff must be deployed in two phases. Phase A revokes legacy
activation and deliberately leaves both legacy and V2 approval unavailable; it
does not yet close legacy submit or direct service-role table DML. The security
gate is not complete until Phase B commits and its checks pass. The application
bridge must already retire every known HTTP writer before authorization,
Portfolio retirement, and Phase A; do not describe that bridge as a database-DML
cutoff before Phase B. The same bridge must be RAW-only for position history and
must quarantine every known legacy history read before the database retirement.

1. After activation passes but before authorization, Portfolio retirement, or Claim Phase A, deploy
   the exact bridge SHA through the protected pipeline. Prove that
   `/api/exchange/connect`, `/api/trader/bind-api-key`, `/api/trader/sync`, and OAuth
   authorize/callback/refresh unconditionally return 410. The auth-first tombstones
   `/api/exchange/verify-ownership` and `/api/traders/claim/verify-wallet` must return
   401 anonymously and 410 when authenticated, with no credential read, proof
   consumption, direct-table fallback, or write. While the new RPCs are still
   absent, prove that `POST /api/trader/authorize` and the new Claim write routes fail
   closed and perform no direct-table write. Also prove fixed 410 for legacy
   Portfolio connect/sync/positions/snapshots, an authenticated no-op snapshot
   cron, and absence of that cron from `vercel.json`. Because the Portfolio export
   RPC is not installed yet, authenticated `POST /api/settings/export` must return
   500 fail closed; a 200 response with `legacy_portfolios` silently omitted is a
   release failure. Also prove app/worker no longer call the legacy position-history
   publisher, maintenance partition/prune no longer includes `position_history`, and
   data/API/warm-cache/UI responses quarantine legacy history as empty/unknown. Record
   that SHA with every result. Keep both ingest writers stopped and drain all legacy
   publisher calls, maintenance partition/prune calls, partition-creator calls, queues,
   and in-flight transactions. Through ADR-023, first apply
   `20260804044000_freeze_legacy_position_history_relations.sql` alone and prove that
   surviving `public.trader_position_history`/`tph_*` relations retain OIDs/data but
   have no runtime DML/DDL path, all guards are enabled, and the partition creator is a
   retired stub. Then apply `20260804041000_retire_legacy_position_history_publisher.sql`
   alone and prove the retained audit/checkpoint chain plus zero application-role
   execute; finally apply `20260804042000_fail_closed_position_history_records_page.sql`
   alone and prove the exact empty/unknown position-history response with other record
   kinds unchanged. Only after all three are exact, prove every legacy Tier-A queue is
   drained and apply
   `20260729061000_tier_a_execution_claim_enforcement.sql` alone; require exact ledger
   plus live marker/trigger/ACL evidence.
2. Keeping that same SHA deployed, apply the authorization migration. Prove its
   quarantine of active legacy alias, OAuth, and unattested connections and its
   revocation of authorizations without an exact canonical connection. Affected
   users must explicitly rebind. The read-only anti-join must return zero active
   authorizations lacking an active connection for the same user, exact
   canonical exchange, and verified UID.
3. Apply `20260803212000_legacy_portfolios_v1_retirement.sql` separately. Prove
   browser/PUBLIC denial, metadata-only direct service read, ciphertext and
   child-table denial, and service-only export/delete RPCs. The settings export
   must pass only the authenticated user id and return HTTP 200 with the complete
   three-dataset manifest and fixture owner rows in staging, using exact allowlisted
   portfolio/position/snapshot fields with no owner id, ciphertext, or cross-owner
   child. Any group above 250,000 rows must return 413 instead of truncation or
   partial success. Also prove cross-owner delete false, parent/child cascade,
   rollback, replay, and unchanged retained rows/ciphertext. In production, a
   zero-row post-cutoff inventory requires ACL/RPC and complete empty-manifest
   proof, not disposable rows. For non-zero rows, record exchange-side revoke/rotate
   separately; deleting Arena's copy does not revoke the key at the exchange.
4. Prove the migration role owns `trader_claims`, then apply only
   `20260803213000_trader_claim_v2_rpcs.sql` (Phase A). Both legacy and V2
   approval must fail closed during this interval.
5. With the already deployed same exact SHA, smoke-test successful authorization
   and a Hyperliquid or GMX challenge, submit, and reject/cancel in the staging
   project. These are the only V1 wallet-claim sources. Every CEX trader-profile
   claim must return unsupported; a CEX API key may create only a private account
   connection and must not create a claim, verified badge, or public first-party
   publication. Re-run the retired
   endpoint checks and the active-authorization anti-join; do not deploy a
   different application SHA between phases.
6. Only after the same exact-SHA success smoke passes and the migration role is
   proved to own every Phase-B preflight relation, immediately apply
   `20260803214000_trader_claim_v2_cutover.sql` (Phase B).
   It takes an access-exclusive lock, expires legacy pending/reviewing rows,
   revokes the legacy RPC and direct claim-table DML, installs the service-only
   canonical V2 activation and the atomic unlink boundary, and then unlocks.
   Smoke the admin approval path through `activate_trader_claim_v2`; it must
   atomically create the exact verified/link/profile/Arena projections. Unlink
   must turn the verified claim
   into rejected audit history, remove the exact verified/link badge authority,
   update primary/profile state, and clear Arena's claimed projection in one
   transaction. It may stop CEX credentials only where source, canonical exchange,
   and trader UID prove the identity mapping. Retained projection drift must fail
   closed; ambiguous legacy credential rows are never guessed and remain an
   owner-audit launch blocker.
7. Run `npm run qa:public-rank-authority-pg17`,
   `npm run qa:retire-legacy-position-history-pg17`,
   `npm run qa:records-page-quarantine-pg17`,
   `npm run qa:trader-claim-v2-pg17`, and
   `npm run qa:legacy-portfolio-retirement-pg17`, then verify production ACLs with
   read-only catalog queries, including denial of browser execution and forced
   rollback after a late unlink write. Only after all five identity/credential
   ACL prerequisites, the missing Tier-A postdeploy, all sixteen production migrations
   (four ranking-authority files, one token-ranking retirement, six
   record/publication/retirement/freeze files, and five
   activation/authorization/Portfolio/Claim files), their live
   proof, the authorization and Portfolio export/delete lifecycle smokes, and the exact-SHA
   Claim submit/approve/unlink smoke have landed, run `npm run gen:types`
   against that production schema and
   commit the genuinely generated type diff.

After the bridge has stopped all legacy public first-party writers, wait at
least 48 hours (the serving freshness window) and prove with a read-only query
that no fresh `provenance='first_party'` ranking input remains. Do this before
recomputing public ranks or inviting Beta users; a non-zero result keeps the
release at NO-GO and requires owner review rather than inferred ownership.

No incident or maintenance window authorizes authorization/Phase A before the
exact bridge SHA is deployed and its pre-migration 410/fail-closed/no-direct-write
smoke passes, or Phase B before that same SHA completes its success smoke. If the
application cannot be proved, stop before the next migration and keep claim
unavailable. Phase B makes legacy claim writers fail closed, so the legacy
application is not a valid claim-path rollback target afterward.
`lib/supabase/database.types.ts` remains
production-generated **DO NOT EDIT** throughout the pre-cutover interval;
schema-ahead access must stay behind local runtime parsing or a narrow cast.

All already-verified claims are intentionally retained when the migrations are
applied; only a later explicit atomic unlink transitions the selected claim and
its projections. Re-run the inventory after the exact bridge cutoff. A zero result
is recorded as time-bound `zero / N/A`; each non-zero row is an owner-audit launch blocker until its identity,
source, proof, user ownership, and matching `verified_traders`, user-linkage,
authorization, and connection projections are reviewed. Record a
retain/quarantine decision and evidence for
every row. Any unresolved, unprovable, duplicate, or conflicting badge keeps
the incident at NO-GO. Use this read-only inventory; do not automatically delete
or downgrade historical rows:

```sql
SELECT
  id,
  user_id,
  trader_id,
  source,
  submission_version,
  verification_method,
  status,
  created_at,
  verified_at
FROM public.trader_claims
WHERE status = 'verified'
ORDER BY verified_at NULLS LAST, created_at, id;
```

The review queue must contain only typed V2 rows after Phase B:

```sql
SELECT submission_version, verification_method, source, status, count(*)
FROM public.trader_claims
WHERE status IN ('pending', 'reviewing')
GROUP BY submission_version, verification_method, source, status
ORDER BY submission_version, verification_method, source, status;
```

Expected: every returned row has `submission_version = 2`, method `signature`,
and source `hyperliquid` or `gmx`. Any other row is a failed cutoff and blocks
launch.

---

## Common Errors and Solutions

| Error                 | Cause                                            | Solution                                                      |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `42P10` in upsert     | Missing unique constraint on ON CONFLICT columns | Add the constraint via migration                              |
| `PGRST301`            | JWT expired or invalid                           | Check Supabase keys in env vars                               |
| `524` from Cloudflare | Request took > 100s                              | Reduce batch size, use inline calls instead of HTTP sub-calls |
| `401` from VERCEL_URL | Deployment protection blocking internal calls    | Use inline (in-process) calls, never HTTP sub-calls in crons  |
| `429` from exchange   | Rate limited                                     | Increase backoff, use VPS proxy                               |
| `CircuitOpenError`    | Too many consecutive failures                    | Wait for circuit breaker reset (60s default)                  |
| Redis `WRONGTYPE`     | Key type mismatch from old data                  | Delete the key: `await redis.del(key)`                        |
| Build OOM             | Not enough memory                                | Set `--max-old-space-size=3584` (already in npm scripts)      |

---

## Supabase Outage

**Status page**: https://status.supabase.com

### What breaks

| Feature               | Impact                                   | Fallback                                                                                                              |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Auth (GoTrue)         | Login/signup fails, JWT refresh fails    | Users with unexpired JWTs can still browse public pages                                                               |
| Database (PostgreSQL) | DB-backed reads and writes fail          | Canonical live/LKG may serve only when health proof says the cached generation is valid; otherwise return unavailable |
| Realtime              | Live chat, live leaderboard updates stop | App remains functional, just not live                                                                                 |
| Storage               | Avatar/image uploads fail                | Existing images served from CDN cache                                                                                 |

### Response steps

1. Confirm outage on https://status.supabase.com or Supabase Dashboard > Project Health
2. If total outage (DB unreachable):
   - Declare or continue incident **NO-GO**. Do not assume the app has degraded safely merely because Redis contains data; verify `/api/health`, canonical generation, freshness, and LKG proof. Unproven cache data must be unavailable, not green.
   - Watch PM2/release logs for authentication failures, rapid restarts, concentrated 5xx, or repeated queue retries. A restart storm is active load amplification, not an expected no-op.
   - If a writer, ingest worker, or cron is looping, stop the exact affected process, save PM2 state, record host/process/release ID, and preserve logs. Do not stop unrelated scraper/proxy services.
   - Keep write workers and all backup/sentinel jobs stopped until credentials, ordered migrations, exact release ID, one controlled queue consumption, and heartbeat are all proved. The local candidate fixes GitHub backup/sentinel jobs false, and all 16 repository workflows are already `disabled_manually`; Dependabot's dynamic workflow remains active. Keep the repository workflows disabled until governance provides native protected source/reviewer capability or an independently approved equivalent auditable boundary. Do not use an automatic restart loop as a recovery test.
   - After the database recovers, inspect `pipeline_logs` and source freshness before any staged restart; restore one canary first and observe a complete scheduling cycle before the remaining Mac mini and Singapore processes.
3. If prolonged (>1 hour):
   - Consider enabling read-only mode via feature flag: set `FEATURE_READ_ONLY=true` in Vercel env
   - This disables write operations (posts, comments, follows) while keeping rankings browsable
4. PITR restore (nuclear option):
   - Supabase Dashboard > Project Settings > Database > Point in Time Recovery
   - Select a timestamp before the incident
   - **WARNING**: This rolls back ALL data changes after that timestamp

---

## Redis (Upstash) Outage

**Dashboard**: https://console.upstash.com

### Mixed fail behavior

Redis consumers do **not** share one fail-open contract. Treat each boundary separately:

| Feature                             | Without Redis                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical public rankings           | Serve only a publication-matched, sanitized LKG when one remains available; otherwise return unavailable/503. Never bypass the canonical contract with a direct DB query. |
| Wallet Claim challenge/replay nonce | Fail closed with 503 and `Retry-After`; no in-memory nonce fallback and no claim submission while replay coordination is unavailable.                                     |
| General API rate limiting           | May fall back to an in-memory per-instance limiter, which is less accurate and must not be treated as a distributed guarantee.                                            |
| Cron/alert locks and deduplication  | Follow the consumer-specific contract; verify the exact job before retrying and never assume duplicate execution is harmless.                                             |

### Response steps

1. Verify status: Upstash Dashboard > your database > Metrics tab.
2. Check `/api/health`, `/api/rankings`, and `/api/traders`. Healthy canonical data must carry a valid publication generation; an LKG must be explicitly marked stale, and absence of a valid LKG must be unavailable rather than a direct DB fallback.
3. Pause wallet-claim testing and communicate the retryable outage while challenge issuance or replay reservation returns 503. Do not introduce an in-memory nonce workaround.
4. Inspect the exact cron/alert consumer before replaying it; preserve deduplication evidence and stop any duplicate write loop.
5. After Redis recovery, prove canonical generation/LKG behavior and one fresh wallet challenge before clearing the incident.

---

## Stripe Webhook Outage / Backup

**Dashboard**: https://dashboard.stripe.com/webhooks

### Checking queued events

1. Stripe Dashboard > Developers > Webhooks > select endpoint
2. Check "Attempted events" tab for failed deliveries
3. Stripe retries failed webhooks for up to 3 days with exponential backoff

### Response steps

1. **Check dedup table**: Events are deduplicated via `stripe_events` table (30-day retention). Even if a webhook is replayed, it won't double-process.
2. **Force replay**: Stripe Dashboard > Developers > Webhooks > select endpoint > "Resend" on specific events
3. **Bulk replay**: Use Stripe CLI:
   ```bash
   stripe events resend evt_xxx --webhook-endpoint we_xxx
   ```
4. **Disable handler temporarily** (if handler is crashing):
   - Stripe Dashboard > Webhooks > endpoint > "Disable endpoint"
   - Fix the handler code, deploy, then re-enable
   - Stripe will replay all queued events from the disabled period
5. **Verify `stripe_events` dedup**: Events older than 30 days are cleaned up automatically. Within 30 days, reprocessing is safely idempotent.
6. **Backup path**: Users who completed checkout but webhook failed can recover via `POST /api/stripe/verify-session` (called automatically from the success page)

---

## Key Infrastructure

| Resource             | Value                                                |
| -------------------- | ---------------------------------------------------- |
| **Supabase Project** | `iknktzifjdyujdccyhsv`                               |
| **Vercel Region**    | `hnd1` (Tokyo)                                       |
| **VPS Singapore**    | `45.76.152.169` (scraper port 3456, proxy port 3001) |
| **VPS Japan**        | `149.28.27.242` (proxy port 3001)                    |
| **CF Worker**        | `ranking-arena-proxy.broosbook.workers.dev`          |
| **Live Site**        | `https://www.arenafi.org`                            |
| **Cron Schedule**    | 53 endpoints / 43 Vercel schedules, staggered        |
| **Scraper PM2 name** | `arena-scraper`                                      |
