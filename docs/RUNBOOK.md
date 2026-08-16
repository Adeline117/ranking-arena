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

**备份是什么**:`backup-to-r2.mjs` 每日 dump `-n arena -n public`(PLAIN SQL,
`--no-owner --no-privileges`)→ gzip → multipart upload → 条件 HEAD 验证，写入
`db-backups/YYYY/MM/arena-backup-<UTC毫秒>-<run-id>-schemas.sql.gz`（schema 产物
保留 14 天）。这是**应用数据备份**，不含 `auth`/`storage`；用户身份当前只有
Supabase 托管 PITR，R2 没有已验证的独立恢复副本。

生产器使用独占的 `0700` 临时目录和 `0600`/`O_EXCL`/`O_NOFOLLOW` 文件；完整流
验证、SHA-256 与 multipart upload 必须绑定同一 sealed artifact。multipart 完成后，
对 exact immutable key 执行条件 HEAD，并按共享 backup/restore contract 核验
size、ETag、`application/gzip`、完整模式/completion metadata 以及
filename/key/`backup-date` identity；任一失败都不得进入 retention prune。新鲜度
检查的 LIST 只用于选择最新 contract-shaped key，健康只以该 exact HEAD 与契约绑定的
`backup-date` 为准；最新对象 invalid、stale 或 future 时必须 fail closed，禁止回退旧
对象报绿。该检查通过只证明 capture artifact 新鲜且契约有效，不代表 managed auth
recovery 已验收。

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

**脚本安全**：当前 restore CLI 在目标身份预检后无条件拒绝 apply；
`--force-prod` 与 `--allow-unverified-target` 只覆盖身份预检分支，不能启用恢复。
在 managed scratch 的 v2 app+auth manifest 演练通过并另行审核前，不得把这两个
参数描述为恢复开关，也不得绕过该最终禁用门禁。

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

恢复 workflow 不是把 `if: false` 改成可运行。恢复前必须逐 job 在 YAML 中实际绑定
只含该 job 最小凭据的受保护 `environment:`，由 required reviewer 与 protected
source/source-trust 规则共同约束，并以契约测试证明不存在 repository-secret fallback。
注释、同名 Environment 的存在或 branch policy 本身都不能替代 job 级绑定；任一条件
缺失时该 job 必须继续保持零 runner。

### Vercel Deployment Protection bypass 轮换门禁

Deployment Protection bypass credential 与 deploy-force 标记是两个不同的能力，两者都不能覆盖 current incident NO-GO。本次发布前必须完成：

当前项目 `protectionBypass={}`，4 个旧 automation/manual credentials 已全部撤销，
count 为 `0`。在 protected source/reviewer 能力不可用期间必须保持为零。

1. `DONE`：撤销所有旧 automation/manual deployment-protection bypass credentials。
2. `BLOCKED`：不要重新签发。只有受保护自动化来源、required reviewer 与最小 consumer manifest 均已证明后，才可评审是否需要一枚新 secret；不得复制到个人终端、issue、日志或报告。
3. 对每个旧值访问 generated deployment URL，保留其返回保护页/401/其他明确失败的证据。当前只有一个旧值具备 HTTP 失败证明，其余三个只有项目 map 归零证明，二者不得混写。
4. 若未来获准新签，证明新值仅在受保护 workflow 内完成获准 smoke。只记录 credential ID/指纹、owner、轮换时间和测试结果，不记录 secret 原文。

旧值仍能访问、新值出现在非受控环境，或无法绑定轮换证据时，发布维持 NO-GO。

### V1 当前 ordered migration 数据库门禁（待执行 / 待证明）

本节与下方“排名权威数据库先行门禁”共同构成一条门禁，不是生产执行记录，也不是批量应用 migration 的授权。任何 ranking 数据库写入前，必须先用独立 edge deny 或从 production exact SHA 派生的最小 fail-closed hotfix 关闭全部 token API/页面并留下 HTTP negative proof；当前整分支包含 schema-coupled 变更，不能拿它冒充该最小止损包。随后按当前候选 cutoff 冻结完整 predeploy ordered baseline，逐项重新裁决 `exact / missing / drift`、依赖与重放安全；旧缺项总数不得复用。五个额外身份/凭据安全前置 `20260716093000_user_linked_traders_server_write_only.sql`、`20260716112000_exchange_connections_server_only.sql`、`20260716178000_user_profile_write_authority.sql`、`20260716179100_user_profile_read_audience.sql`、`20260716179200_user_profile_wallet_authority.sql` 也须同时证明。position-history 必须经过 legacy retirement/quarantine/freeze 与 RAW prerequisites，最终由 `040500` 前向重开严格 verified `@2`；Tier-A postdeploy 仍是独立门禁。任一门禁未证明即维持 NO-GO。

旧的 2026-08-04 `READ ONLY` production 审计早于 `20260804045000_verified_position_history_raw_prerequisites.sql`、`20260804050000_verified_position_history_publication_authority.sql` 与 `20260804050500_harden_serving_trader_resolver.sql`，其 predeploy/postdeploy 总数、gap 数、missing/live 结论和函数状态只能作为历史线索。当前 production 状态统一为 **PENDING RE-AUDIT**：先冻结当前完整 ordered manifest、ledger、函数 overload、ACL、trigger、relation OID 与 live catalog，再逐项记录 `exact / missing / drift`；新审计完成前不得写总数或批准 DDL。transaction pooler 只用于只读取证，不是 migration writer；`5432 + verify-full` session 通道仍须另证。

以下三十个 2026-08 migration 是当前仓库 inventory；production apply 状态待重新只读复核。这不是 apply 授权，最终 pass 必须绑定同一个 exact candidate SHA。其中历史文件 `040550` 仍在 runner 外，但因会覆盖 registry-bound V2-only `@4` reader，当前明确 **HOLD / 不得执行**：

1. `20260803090000_record_provenance_clocks.sql`
2. `20260803100000_record_surface_publication_substrate.sql`
3. `20260803101000_verified_position_history_publication_writer.sql`
4. `20260803153000_stripe_webhook_event_lease_and_retention_authority.sql`
5. `20260803170000_atomic_verified_trader_profile_revision.sql`
6. `20260803180000_hashtag_read_authority.sql`
7. `20260803183000_post_interaction_read_privacy.sql`
8. `20260803211000_b2c_activation_v2.sql`
9. `20260803211500_trader_authorizations_server_only.sql`
10. `20260803212000_legacy_portfolios_v1_retirement.sql`
11. `20260803213000_trader_claim_v2_rpcs.sql`（Claim Phase A）
12. `20260803214000_trader_claim_v2_cutover.sql`（Claim Phase B）
13. `20260804041000_retire_legacy_position_history_publisher.sql`
14. `20260804042000_fail_closed_position_history_records_page.sql`
15. `20260804043000_retire_legacy_token_rankings.sql`
16. `20260804044000_freeze_legacy_position_history_relations.sql`
17. `20260804045000_verified_position_history_raw_prerequisites.sql`
18. `20260804050000_verified_position_history_publication_authority.sql`
19. `20260804050500_harden_serving_trader_resolver.sql`
20. `20260804051000_harden_serving_source_capabilities.sql`
21. `20260804052000_fail_closed_unbound_copier_aggregates.sql`
22. `20260804052500_quarantine_bingx_rank_authority.sql`
23. `20260804053000_copier_snapshot_publication_substrate.sql`
24. `20260804054000_copier_snapshot_publication_authority.sql`
25. `20260804054200_harden_copier_snapshot_receipt_provenance.sql`
26. `20260804054300_copier_snapshot_lane_v2_authority.sql`
27. `20260804054500_correct_okx_copier_depth_contract.sql`
28. `20260804054600_correct_copier_depth_contracts.sql`
29. `20260804054700_bind_copier_snapshot_source_authority.sql`（runner 外，app-first 人工单文件 cutover）
30. `20260804055000_copier_snapshot_direct_write_cutover.sql`（runner 外，**HOLD / 不得执行**）

`040550`：**HOLD**。`040543` 只保留 V1 RPC symbol/ACL 与 `@1` receipt projection 的 binary/read compatibility；它在锁内要求 legacy `event_history + (job_type=history:copiers 或 history_kind/surface=copiers)` RAW 为零，并安装 NULL-safe CHECK 永久禁止该输入，因此 V1 writer 在 `040543` 后不能再产生 receipt。`040547` 再把公开 reader 前向替换为 `arena.copier-snapshot-receipt-reader@4`：只接受 exact immutable registry 中 publication-eligible source/depth/currency/verifier 所绑定的当前 V2 receipt，不再读取 V1 或 legacy fallback；V1 symbol 仅剩 binary compatibility。现有 `040550` 的旧函数体只认识 V1 receipt，执行后会覆盖 `@4` 并让已经发布的 Tier-B/Tier-C V2 数据从公开 reader 消失。不得修改这个历史候选来掩盖问题，也不得设置其 attestation。任何未来撤销 V1 symbol 的动作都必须另建版本号大于 `040550` 的前向 migration，并重新完成 worker/queue 排空、exact registry coverage 与独立审批。

在 writer/queue/in-flight 全停且候选 V2 code 仅 staged 的同一部署窗口，`040543` 前只读证据必须保存以下结果且为 `0`；该查询不授权删除或重标任何行：

```sql
SELECT pg_catalog.count(*) AS legacy_copier_event_history_raw_count
FROM arena.raw_objects AS raw_object
WHERE raw_object.trust_artifact_role IS NOT DISTINCT FROM 'event_history'
  AND (
    raw_object.job_type IS NOT DISTINCT FROM 'history:copiers'
    OR raw_object.meta->>'history_kind' IS NOT DISTINCT FROM 'copiers'
    OR raw_object.meta->>'surface' IS NOT DISTINCT FROM 'copiers'
  );
```

必须使用以下有序流程：

0. 在针对当前 production exact SHA 的新 HTTP/cache/zero-backend probe 完成前，把 legacy token-ranking surface 按 **ACTIVE-EXPOSURE** 处理；2026-08-04 00:04 PDT 的历史公开探针只作为事故线索，不冒充当前数字。任何 predeploy/ranking migration 前，custom domain 与全部别名上的 `/api/rankings/by-token` detail/popular 请求必须固定 fail closed，`/rankings/tokens` 与 `/rankings/tokens/*` 不得渲染或请求旧排名；响应必须不可缓存，且日志/测试证明零 Supabase/Redis 调用。优先使用获准、可回滚且覆盖所有别名的 edge deny；若用代码，只能从 production exact SHA 建立 allowlist 极小的独立 hotfix。该负向门禁从第一项 ranking migration 前持续到 `040430` exact proof；未完成即数据库零写入。
1. 以当前候选 cutoff 冻结完整 predeploy ordered baseline，为每项重新建立 `exact / missing / drift`、依赖与重放安全证据。四个 ranking 文件是 manifest 内的普通有序项，不是可跳过前序的额外批次；只有位于目标文件之前的每一项 exact、目标确认 missing 且 live catalog 与迁移前契约兼容时，才在抵达其位置后按四文件固定顺序逐文件补齐。当前 manifest 全部 exact 前，predeploy 门禁仍未闭合，也不开始后续 2026-08 数据库变更。
2. 在任何 2026-08 migration 前，用 production exact ledger 与 live ACL catalog 同时证明五个额外安全前置。`20260716093000` 必须令 `user_linked_traders` 对 browser/PUBLIC 无 DML、authenticated 仅 own SELECT、service role CRUD 且 policy 精确收敛；`20260716112000` 必须令 `user_exchange_connections` 对 browser/PUBLIC 无 table/column 路径、service CRUD 且只有精确 service policy；`20260716178000`/`179100`/`179200` 必须共同保护 profile 写入/读取/钱包权威，尤其 authenticated 不可更新 `is_verified_trader`、`verified_trader_id`、`verified_trader_source`、`linked_trader_count`。仅当当前只读检查确认某 ledger missing、live catalog 仍与迁移前基线兼容时，才按时间顺序通过 ADR-023 获准单文件通道补齐并重复 ACL 证明；ledger/catalog 冲突时停止，不修 ledger、不盲目重放。
3. 四个 ranking-authority migration 均 exact 后，为 `20260804043000_retire_legacy_token_rankings.sql` 准备独立 ADR-023 门禁，但不得把它提前到 ordered manifest 的位置之前。实际执行点位于 `040420` 与 `040440` 之间；届时必须以 publication-head `FOR UPDATE NOWAIT` 证明没有在途 refresh 并精确匹配 generation-barrier 前态，随后证明 generation-zero unpublished head、exact cron inactive、七个函数和两个 MV OID/内容保留、reader/writer/MV ACL fail closed 且重放 byte-stable。当前 production 前态待重新只读复核；任何 prerequisite、hash、overload、ACL、在途 refresh 或 ledger/live drift 都停止。
4. 完整 predeploy/ranking baseline 与所有 drift 经独立审查闭合后，在受保护 staging 按 `20260803090000` → `20260803100000` → `20260803101000` 逐文件建立 record/publication 基础链。逐项证明 provenance/observation/publication clocks、private immutable publication chain、legacy verified writer、checkpoint/chain-health RPC 与原子 receipt。后续 retirement/reopen 由步骤 7 按真实顺序处理；任何 preflight、ACL、链完整性、artifact 版本混用或 ledger/live drift 都停止。
5. 在受保护 staging 单文件通道应用 activation migration，证明 epoch 行、v2 RPC、`service_role` 只读指标契约和旧事件解析兼容。
6. 在 authorization、Portfolio retirement 与 Claim Phase A 尚未应用时，通过受保护发布管线部署候选 exact bridge SHA。证明旧 connect、bind、sync 与 OAuth 入口无条件固定 410；两个 auth-first tombstone `/api/exchange/verify-ownership` 和 `/api/traders/claim/verify-wallet` 必须分别为匿名 401、已登录 410，且没有凭据读取、proof consumption 或 direct-table fallback。另证明新的 authorize POST/Claim 写路径因 RPC 缺失而 fail closed，旧 Portfolio 四入口固定 410，snapshot cron 为认证 no-op 且未调度；Portfolio export RPC 尚不存在时，已认证 export 必须返回 500。保留的 EVM address portfolio/suggestions 不属于旧凭据面。还必须证明 app/worker 不调用 legacy position-history publisher/cursor/maintenance；legacy、漂移或自报 complete 的 history 在 data/API/warm-cache/UI 边界继续 quarantine。Tier-C 仅可提供无 cursor、限页、partial 的 RAW-backed preview，不能写 typed history 或作为排名证据。保持两台 writer 停止，排空 legacy publisher、reader、maintenance、partition creator、queue 与在途事务；记录 exact SHA，到 Phase B 后验证结束不得换包。
7. 保持该 exact bridge SHA 和所有 copier writer/queue/in-flight job 停止；候选 V2 code 可以先 staged，但 worker artifact 不能启动。`040410` → `040420` → `040430` → `040440` → `040450` → `040500` 不在任何 runner array，必须继续分别通过各自 ADR-023/受保护人工单文件门禁按序执行。standard runner manifest 中的 copier tail 仅列 `040505` → `040510` → `040520` → `040525` → `040530` → `040540` → `040542` → `040543` → `040545` → `040546`；这只证明候选清单顺序，不授权 runner 写 production，production 仍须由 ADR-023 获准通道逐文件执行并止于 `040546`。`040547` 不得加入 `PREDEPLOY_MIGRATIONS`、`POSTDEPLOY_MIGRATIONS`、recovery、quarantine 或 superseded array；它只能在下述 app-first/cache 门禁全部闭合后，以受保护的人工单文件通道执行。这与 `040550` 不同：`040547` 是满足全部人工门禁后可执行的 forward authority cutover；`040550` 是永久 HOLD，任何 runner 或人工 session 都不得执行。

   `040430` 仍是不可提前的独立 token-ranking retirement；其余 position-history 与 copier prerequisites 也不得跳位。`040530` 建立私有不可变 receipt/row substrate；`040540` 安装 service-only V1 publisher 与 receipt-first bridge；`040542` 必须在零 receipt/row 前态下安装最终 INSERT/Claim/clock/privacy 门禁。执行 `040543` 前还必须只读证明 legacy `trust_artifact_role='event_history'` 且 `job_type='history:copiers'`、`meta.history_kind='copiers'` 或 `meta.surface='copiers'` 任一成立的 RAW 为零；若非零必须停止，通过单独审批的证据保留/归档流程处理，不得在 migration 内删除、重标 role 或改写历史。`040543` 的锁内 preflight 会再次证明 receipt/row 与上述 legacy RAW 均为零，然后扩展 `copier_audit`/`copier_snapshot` RAW role、永久禁止 legacy copier event-history 输入并安装 lane-bound V2 authority，把 exact 13-key request、7-key receipt、wrapper/acquisition digest、Tier-B/Tier-C lane、subject/clock/terminal/raw-integrity 证据绑定到不可变 receipt；V1 RPC symbol/ACL 仅为 binary compatibility 保留，已没有合法 copier RAW 输入，`@3` reader 只是此时尚未完成 source-authority cutover 的中间投影。`040545` 先收紧 OKX futures/spot depth，`040546` 再按逐源审计纠正 Gate、Bybit、BingX、Blofin、HTX、Phemex 与 BitMart 的 depth，且明确不把 top-100 capped 的 LBank 冒充 full；这些 postflight 通过后 writers 仍须停止。

   `040547` 会先把 Bitget human futures/spot/cfd 与 XT spot 的无证明 `full` 降为 `none`，再安装 14 行 postgres-owned immutable source registry：13 行 publication-eligible exact source/adapter/product/scope/currency/depth/verifier，LBank 固定为 `top3_preview + publication_eligible=false + verifier=NULL`。同一 transaction 以 5 个 ALWAYS trigger 阻止 source、trader external identity、receipt 与 registry 的 direct DML/replica bypass，永久冻结 registry source 下 trader 的 `id/source_id/exchange_trader_id`，并以 source/trader `FOR SHARE` 串行化降级、重绑和发布竞争；7 个 exact function SHA 同时锁定 canonical V2 publisher、4 个私有 guard、V2-only `@4` reader 与 live capability overlay。公开 reader/capability 只接受 exact current receipt；V1、旧 verifier、未注册、LBank、quarantined、cross-source trader 与 latest-invalid receipt 均不得公开。PG/smoke 必须覆盖 V1 symbol 仍存在但 legacy input 永久拒绝、Tier-B/Tier-C V2、exact/conflicting/tombstone replay、Claim 双向锁、未来时钟、inactive/shadow/none/currency subject、RAW role/job/path/clock/hash/meta、terminal/integrity、row provenance、histogram anonymity、browser/PII denial、depth correction、registry/catalog/ACL、reader/capability marker、RAW GC tombstone、replica、source demotion和 trader rename/publication 双向竞争。获批 canary 之前不得用 production 写入试探；任一排空、preflight、ACL、hash、ledger/live 或契约证明失败都停止。

   `040547` 的 B2C cutover 必须严格 app-first，并冻结 production rollout/promote/rollback。先部署 fail-closed web release；worker artifact 只能 staged 且未启动。web 必须要求 `records_contract=csr2`、`receiptReaderContract=arena.copier-snapshot-receipt-reader@4` 与 `copierAuthorityContract=arena.copier-snapshot-source-authority@1`，使旧 DB、缺 marker capability、`csr1` records 与旧缓存 payload 在应用边界全部 fail closed。不得用 `origin/main` SHA 冒充线上证据：通过 authenticated Vercel API 保存 exact `teamId/projectId`、production alias 指向的 deployment ID、`target=production`、`READY` 和 `meta.githubCommitSha=候选 release SHA`；purge 前后必须是同一 deployment。purge 前后还必须调用 `/v1/projects/$PROJECT_ID/rolling-release?teamId=$ORG_ID` 并证明 `rollingRelease=null`；存在 rolling release、bucket 仍可能命中旧 base、deployment 漂移、deploy 失败、回滚或未 promote 都是 NO-GO。

   只有上述 production identity 证据成立后，才对同一 exact deployment 运行 `bash scripts/maintenance/purge-ranking-authority-caches.sh plan`，经审批执行 `apply`，并保存 Next/Vercel Data 与 CDN purge 证明；随后从至少两个网络点证明 `kind=copiers&records_contract=csr1`、旧 HTML/capability、marker-less DB 响应均不能显示 Copiers。无法证明 exact purge 或旧 SSR HTML 已失效时必须直接 NO-GO，`040547` 不得应用、writers 继续停止；旧 records 900 秒 SWR 与 capability/SSR 3600 秒只描述潜在暴露窗口，绝不是等待后继续的替代门禁。

   全部 app/cache 负向证据绑定同一 release/deployment 后，才人工单文件应用 `20260804054700_bind_copier_snapshot_source_authority.sql`。核对 14 行 registry、4 项 depth correction、7 个 exact function SHA、5 个 ALWAYS trigger、trader identity freeze、publisher/projection ACL/RLS、`@4` reader、capability marker 与 exact postflight，并完成 PostgREST schema reload；再 purge/reprobe 新 `csr2`/marker 路径与全部旧路径负例。此时 production 尚无新 receipt 时，staging/PG fixture 的正向结果不能冒充 production smoke：只启动一个获批 source/trader、bounded、exact artifact SHA 的 V2 canary job/worker 来生成一条正常 receipt；失败立即停止 canary并 NO-GO。只有该 receipt 的 `@4` reader、live capability、`csr2` HTTP 和无 PII 正向 smoke 同时通过，且旧路径仍全负向，才可逐步扩到全部已注册 V2 writers。不得用全量 writer 启动来试探数据库。

8. 继续保持 writer 停止，证明所有 legacy Tier-A worker/queue 已排空且完整 predeploy manifest exact，再重新只读审计 `20260729061000_tier_a_execution_claim_enforcement.sql`。仅当它确认为 missing 且 live catalog 与 preflight 兼容时，才通过 ADR-023 单文件应用并核对 exact ledger、live marker、触发器、ACL、旧 unclaimed RPC 拒绝和 claimed worker 契约。任何残留 writer/queue 或 catalog drift 都停止。
9. 保持该 bridge SHA，再应用 authorization migration。它的 preflight 必须拒绝未满足上述 exchange-connection ACL 的环境；迁移必须隔离 active legacy alias、OAuth 或缺少 attestation 的 connection，并撤销没有同用户、同 exact canonical exchange 与同 verified UID 的 active connection 支撑的 authorization。这些账户必须由用户显式 rebind，不得自动提升旧记录。随后证明两张凭据表对 browser roles/PUBLIC 均无 table/column 路径，bind/revoke 两个原子 RPC 均无 browser/PUBLIC execute 路径且仅 service role 可调用。在 disposable fixture 依次证明公开选择器只有 Binance、Bybit、Bitget；首次绑定同时写入两张投影；同一 canonical exchange 重绑撤销旧 active authorization；两种 revoke selector 都同时停用 connection 并撤销全部匹配 authorization；绑定或撤销任一投影失败时整条 RPC 原子回滚。最后运行只读反连接，结果必须为零：每条 active authorization 都必须有同用户、同 exact canonical exchange、同 verified UID 的 active connection。这个顺序有意不按文件时间排序。
10. 单独应用 Portfolio retirement。核对三表/cascade FK exact shape；browser/PUBLIC 零 table/column 权限；service 无直接 DML、无密文/positions/snapshots direct SELECT，仅有五个 metadata 列 SELECT；唯一 policy 为 service metadata read；`export_legacy_portfolio_data_v1(uuid)` 与 delete RPC 仅 service 可执行。行级 fixture 只在 staging 建立：证明 authenticated RPC deny、HTTP export 固定传认证 user id、迁移后返回 200，`account.legacy_portfolios` 与 manifest 完整包含 portfolios/positions/snapshots 三项及 fixture owner rows，字段精确白名单、无 user id/密文且 child 不越出 owner portfolio set；任一组超过 250,000 行必须返回 413，而不是截断或返回部分成功。同时覆盖跨 owner delete false、parent/child cascade、故障回滚、重放，以及迁移不删除 owner 行、不改写密文。production inventory 若仍为零，只验证 ACL/RPC 与完整空 manifest，不创建 disposable 行；若非零，才导出 owner/交易所 metadata 清单并要求 owner 下载、交易所侧 revoke/rotate 和 Arena 清理裁决。
11. Claim Phase A 前只读证明 migration role exact 拥有 `trader_claims`，再应用 Phase A。核对 typed submit/reject/cancel、guard、ledger/reload，并证明 legacy activation 与 Arena claimed helper 均不可执行。Phase A 没有批准能力，不是“可批准的向后兼容层”。
12. 使用同一 exact bridge SHA 完成 authorization 和 Hyperliquid/GMX challenge → submit → `reviewing` → reject/cancel smoke；legacy 与 V2 approval 此时都须 fail closed。所有 CEX claim 均 unsupported，CEX API key 不得创建 claim/badge。
13. Phase B 前只读证明 migration role exact 拥有 migration preflight 列出的全部 relation。只在同一 SHA 成功 smoke 后单独应用 Phase B，证明 legacy submit/direct DML fail closed、canonical `activate_trader_claim_v2` 管理员批准成功并原子更新 badge/link/profile/Arena，且 unlink 仅 service 可执行、任一步失败全部回滚。Phase A/B 不得批量连续应用。
14. staging 通过后 production 按当前 ordered manifest 严格重复：维持 token surface HTTP containment；完成 ranking authority prerequisites 与 record provenance/publication/legacy writer 基础链；部署并验证同一 exact bridge；先分别通过 ADR-023/受保护人工单文件门禁按 `040410` retirement → `040420` quarantine → `040430` 独立 token-ranking retirement → `040440` freeze → `040450` RAW prerequisites → `040500` verified `@2` authority 执行。standard runner manifest 中的 copier tail 仅列 `040505` active-serving resolver → `040510` serving capabilities → `040520` unbound-copier containment → `040525` BingX rank quarantine → `040530` copier receipt substrate → `040540` copier publication authority → `040542` copier receipt provenance/privacy hardening → `040543` lane-bound V2 authority → `040545` OKX copier depth correction → `040546` reviewed copier depth corrections；runner 的 production write command 仍禁用，production 必须继续由 ADR-023 获准通道逐文件执行。`040542` 与 `040543` 的 locked preflight 都必须证明 receipt 与 row 均为零；`040543` 还必须在 writer/queue/in-flight 全停且候选 code 仅 staged 的状态证明 legacy copier event-history RAW 为零。任一已有数据都停止，不能在 migration 内删除、重标或改写证据语义。随后严格执行步骤 7 的 app-first exact production deployment/`rollingRelease=null`/Data+CDN purge/旧路径 fail-closed 门禁，才可人工单文件应用 `040547`；其 registry/trader identity/trigger/reader/capability/publisher ACL/postflight 与 schema reload 全绿后，只运行一个 bounded exact-SHA V2 canary，完成 production `@4`/authority marker/`csr2`/无 PII 正向 smoke，再扩到其余已注册 writers。之后完成 Tier-A 单文件门禁、authorization、Portfolio retirement、Claim Phase A、同 SHA smoke 与 Claim Phase B。每个文件单独提交并核对 exact ledger/live catalog/ACL/RPC/reload；不得用 `db push`、历史批量重放、等待缓存 TTL 或仅停 writer 替代。`040547` 可在人工门禁闭合后执行但不属于任何 runner phase；`040550` 则是永久 HOLD，任何 attestation、runner 或人工 session 都不得执行。
15. production 未获准时不创建 disposable claim 或 portfolio。Phase B 后 legacy application 不是有效回滚目标。
16. 只有五个额外 ACL 前置、Tier-A postdeploy 当前状态裁决、当前 production manifest 的全部 exact proof、token-ranking、完整 position-history verified `@2` authority、BingX rank quarantine、copier V2 publication authority、V1 binary-only compatibility、两项 reviewed copier depth correction、`040547` exact source registry/V2-only `@4` reader/capability authority、app-first `csr2` cache cutover、authorization、Portfolio 和 Claim 全生命周期 smoke 闭合后，才能从 production 运行 `npm run gen:types`。`040550` 当前 HOLD，不存在可执行前置清单；未来替代迁移必须另行审查。
17. 运行 migration history shape、前置与 2026-07 suites；`npm run qa:public-rank-authority-pg17` 必须覆盖 token-ranking retirement 的在途 refresh 回滚/排空重试、generation-zero head、reader/writer/MV ACL fail-closed、OID/MV 内容保持、cron identity 保持和 byte-stable replay。再运行 record/publication 基础、legacy writer retirement、records quarantine、relation freeze、`040450` RAW prerequisites、`040500` verified publication authority、`npm run qa:serving-trader-resolver-pg17`、`npm run qa:bingx-rank-quarantine-pg17`、`npm run qa:copier-snapshot-authority-pg17`、`npm run qa:copier-snapshot-provenance-pg17`、`npm run qa:copier-snapshot-lane-v2-pg17`、`npm run qa:okx-copier-depth-contract-pg17`、`npm run qa:reviewed-copier-depth-contracts-pg17`、`npm run qa:copier-snapshot-source-authority-pg17` 与 `npm run qa:copier-snapshot-cutover-pg17` 的全部静态/PG17 suites，以及 cache purge、activation、authorization、legacy-portfolio-retirement、claim-cutover suites。任何证据不完整即 NO-GO。`qa:copier-snapshot-cutover-pg17` 仅保留为旧候选在隔离 PG17 的历史门禁证明；它不授权 staging/production 执行，且不能覆盖 `040550` HOLD。
18. Phase B 后重新 inventory 历史 verified rows 与 legacy Portfolio key；零行记录 `zero / N/A`，只对非零行逐项审计身份投影或完成 revoke/rotate、联系与归属裁决。
19. 从 exact bridge 停止所有旧公开 first-party writer 起等待至少 48 小时，并只读证明没有 fresh `provenance='first_party'` 排名输入后，才可重算或开放 Beta。

#### `040550` runner 外人工切换门禁（HOLD / 不得执行）

`040550` 默认直接执行必须失败，也不得加入 `PREDEPLOY_MIGRATIONS`、`POSTDEPLOY_MIGRATIONS`、recovery 或其他 standard runner array。它当前不是“满足条件即可执行”的候选：可人工门禁执行的 `040547` 已把公开 reader 前向升级为 V2-only `arena.copier-snapshot-receipt-reader@4`，而 `040550` 的旧体会回写 V1-only reader，因此即使旧 attestation、worker/process/queue 与 coverage 条件全部满足也必须停止。以下 coverage 查询仅作为未来版本号更大的 lane-aware 替代 migration 的输入模板，不授权现文件：

```sql
WITH required_trader AS (
  SELECT source_row.id AS source_id,
         source_row.slug AS source_slug,
         trader_row.id AS trader_id
  FROM arena.sources AS source_row
  JOIN arena.traders AS trader_row
    ON trader_row.source_id = source_row.id
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND source_row.copier_table_depth IN ('full', 'top10', 'top3_preview')
), latest_candidate AS (
  SELECT DISTINCT ON (publication.source_id, publication.trader_id)
         publication.*
  FROM arena.copier_snapshot_publications AS publication
  JOIN required_trader AS required
    ON required.source_id = publication.source_id
   AND required.trader_id = publication.trader_id
  ORDER BY publication.source_id,
           publication.trader_id,
           publication.observed_at DESC,
           publication.publication_id DESC
), covered AS (
  SELECT candidate.source_id, candidate.trader_id
  FROM latest_candidate AS candidate
  WHERE candidate.evidence_state = 'verified'
    AND candidate.scan_terminal_state = 'exhausted'
    AND NOT candidate.caller_limited
    AND candidate.blocker_reasons = '[]'::jsonb
    AND candidate.copier_count = candidate.parsed_row_count
    AND (
      candidate.live_raw_object_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM arena.raw_objects AS raw_object
        WHERE raw_object.id = candidate.live_raw_object_id
          AND NOT raw_object.quarantined
      )
    )
)
SELECT required.source_slug,
       count(*) AS required_traders,
       count(covered.trader_id) AS receipt_covered_traders,
       round(100.0 * count(covered.trader_id) / NULLIF(count(*), 0), 2)
         AS receipt_coverage_percent
FROM required_trader AS required
LEFT JOIN covered
  ON covered.source_id = required.source_id
 AND covered.trader_id = required.trader_id
GROUP BY required.source_slug
ORDER BY required.source_slug;
```

每个 source 必须达到变更单事先批准的阈值，且不得因切换而变成永久空白；临时自行降低阈值无效。独立审批必须绑定 coverage 结果、worker/queue 证据、未来替代 migration SHA 和 release SHA。当前没有可执行命令；尤其禁止运行下列旧流程：

```bash
# HOLD — DO NOT SET arena.copier_snapshot_direct_write_cutover_attestation
# HOLD — DO NOT APPLY 20260804055000_copier_snapshot_direct_write_cutover.sql
# A future reviewed migration with version > 20260804055000 must preserve
# lane-aware receipt reads and own its separate manual-only instructions.
```

任何环境都必须停在已完成当前 ordered predeploy 的 V2-only publication、V1 binary/receipt-projection compatibility 状态；不得因旧 attestation 可设置、旧隔离测试通过或 coverage 达标而越过 HOLD。

### 排名权威数据库先行门禁（BLOCKED / 已取证）

以下步骤是当前 ordered migration 门禁的一部分，不是生产执行授权。2026-08-04 00:04 PDT 的历史公开探针曾证明 legacy token-ranking surface 为 **ACTIVE-EXPOSURE**，但 Beta/release 前仍须针对当前 production exact SHA 重新探测 HTTP、cache 与零后端调用。旧 production 数据库审计早于当前 manifest，其 ranking ledger/live 与其他缺项结论必须重新只读复核；结论在新证据闭合前仍为 **BLOCKED**。不得把历史“missing”记录误解为可以直接补文件，更不得批量重放或手改 ledger。

0. 在任何 ranking DB 写入前，先以获准 edge deny 或独立最小 hotfix 封闭 custom domain 与全部别名上的 token detail/popular API、index/detail 页面、导航和 sitemap 发现入口。API 必须固定 503（或经单独评审固定 410）、无 traders/tokens/total、`Cache-Control: private, no-store, max-age=0, must-revalidate`，页面不得挂载会 fetch 的 client；日志和测试必须证明零 Supabase/Redis 调用。发布后从两个网络点以不同 query 验证无旧 public cache，并绑定 exact deployment SHA。该门禁持续到 `040430` exact；通过前不应用任何 predeploy/ranking migration。
1. 在应用候选版本前，以当前 cutoff 冻结完整 predeploy manifest、production ledger 与 live catalog 快照。逐项重建 `exact / missing / drift`、现有 catalog 兼容性、依赖与重放安全证据，并为每个确需应用的文件建立 ADR-023 单文件记录。四个 ranking 文件属于该 ordered manifest；任一目标文件的全部前序或 drift 未闭合时，该文件及其后续写入均禁止执行。
2. 只有四个目标各自的完整 manifest 前序已闭合、`5432 + verify-full` 获准 migration writer 已证明、且每个文件的 ADR-023 审批齐全后，才可在 ordered manifest 抵达它们时严格按以下顺序逐文件提交；每次只提交一个完整文件并立即核对 exact ledger/live catalog，不得使用本地 `db push`、批量历史重放或脚本中已禁用的 psql 写命令：
   1. `20260729223000_rerank_public_eligible_rows_only.sql`
   2. `20260729224000_rank_eligible_leaderboard_count_cache.sql`
   3. `20260729225000_token_trader_rank_authority.sql`
   4. `20260729230000_token_ranking_generation_barrier.sql`
3. 第四个 ranking-authority migration exact 后，不调用 `refresh_popular_tokens_mv()`，不等待 cron 发布，不读取或展示 legacy/v2 token-ranking payload，也不要求 `generation_seq > 0`。这些数据缺少 frozen rank-eligible authority snapshot；生成新 generation 只会扩大不可信发布面。只通过获准 `READ ONLY` catalog 审计确认七个 callable、两个 populated MV、publication-head singleton、唯一 exact cron identity 与 predecessor body/ACL shape，并确认没有 refresh 在途。token containment 必须持续，但 `040430` 不得提前越过 ordered manifest 中的 `030900`、`031000`、`031010`、V1 `0321*`、`040410` 与 `040420`。
4. 当前 ordered manifest 到达 `040420` 后、`040440` 前，才通过 ADR-023 单文件应用 `20260804043000_retire_legacy_token_rankings.sql`。最终并发屏障由 `FOR UPDATE NOWAIT` 负责；若 publication-head 锁冲突，整事务失败，先排空 refresh 再重试，不得手动触发 refresh 作为“修复”。提交后核对 exact ledger、PostgREST reload、durable/RPC head 的 `generation_seq=0` 与其余时间字段为 NULL、两个 row count 为 0；核对 exact `refresh-mv-popular-tokens` cron job identity 保持且 `active=false`。七个函数和两个 MV 的 OID、MV definition/populated/content 必须保持；除 service-role head getter 外，六个关闭函数、两个 MV 的 table/column/delegated ACL 对全部 runtime role 均不可用，所有 retired reader/writer 探针返回精确 SQLSTATE `55000`。最后重放一次并证明 catalog/ACL/body hash byte-stable。只读 HTTP head 核验必须使用 `/rest/v1/rpc/get_token_ranking_publication_head` 并满足：

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
6. `040430` retirement exact proof 完成后，保持 token HTTP containment，并按 ordered manifest 继续 `040440` relation freeze → `040450` RAW prerequisites → `040500` verified `@2` publication authority → `040505` active-serving resolver → `040510` BingX rank quarantine。随后必须完成 verified 首屏/续页/reset/quarantine smoke、inactive/shadow source resolver 拒绝和 Tier-C partial/no-cursor 负向证明，再继续 Tier-A 单文件门禁、authorization、Portfolio retirement、Claim Phase A、同 SHA smoke 与 Phase B；不得回到旧的 freeze → writer retirement → records quarantine 顺序，也不得把 `040510` 提前到 `040505` 之前。
   第二个迁移会在同一事务中切换 legacy rerank wrapper、重排三个 season 并重建
   rank-derived count；第三个迁移是 token 榜 `token_rank` 应用契约的数据库先行
   条件；第四个迁移是跨页 generation read barrier；第五个核心 ranking migration
   将未绑定 authority snapshot 的旧 token publication 整体 fail closed。不得少应用
   其中任一迁移后发布应用。
7. `20260804052500_quarantine_bingx_rank_authority.sql` exact ledger、live catalog 与 PostgREST reload 闭合后，通过同一获准数据库通道执行以下只读核验。结果必须全部为 `true`：

   ```sql
   BEGIN TRANSACTION READ ONLY;

   SELECT count(*) = 1 AND bool_and(NOT active) AS token_cron_retired
   FROM cron.job
   WHERE jobname = 'refresh-mv-popular-tokens';

   SELECT
     has_function_privilege(
       'service_role',
       'public.get_token_ranking_publication_head()',
       'EXECUTE'
     )
     AND NOT has_function_privilege(
       'service_role',
       'public.get_token_trader_rankings(text,integer,integer,integer)',
       'EXECUTE'
     )
     AND NOT has_function_privilege(
       'service_role',
       'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)',
       'EXECUTE'
     )
     AND NOT has_function_privilege(
       'service_role',
       'public.get_popular_tokens_v2(integer,integer,bigint)',
       'EXECUTE'
     )
     AND NOT has_function_privilege(
       'service_role',
       'public.refresh_popular_tokens_mv()',
       'EXECUTE'
     ) AS legacy_token_rpcs_closed;

   SELECT
     NOT has_table_privilege(
       'service_role', 'public.mv_token_trader_daily_90d', 'SELECT'
     )
     AND NOT has_table_privilege(
       'service_role', 'public.mv_popular_tokens_90d', 'SELECT'
     ) AS legacy_token_mvs_closed;

   WITH RECURSIVE named_root(relation_oid) AS (
     SELECT relation.oid
     FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace_row
       ON namespace_row.oid = relation.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND relation.relname IN (
         'trader_position_history',
         'trader_position_history_partitioned',
         'trader_position_history_old'
       )
       AND relation.relkind IN ('r', 'p')
   ), relation_tree(relation_oid) AS (
     SELECT relation_oid FROM named_root
     UNION
     SELECT inheritance.inhrelid
     FROM relation_tree
     JOIN pg_catalog.pg_inherits AS inheritance
       ON inheritance.inhparent = relation_tree.relation_oid
   ), guarded_relation(relation_oid) AS (
     SELECT relation_oid FROM relation_tree
     UNION
     SELECT relation.oid
     FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace_row
       ON namespace_row.oid = relation.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND relation.relname LIKE 'tph\_%' ESCAPE '\'
       AND relation.relkind IN ('r', 'p')
   )
   SELECT count(*) > 0 AND bool_and(
     relation.relowner = 'postgres'::regrole
     AND relation.relrowsecurity
     AND relation.relforcerowsecurity
     AND has_table_privilege('service_role', relation.oid, 'SELECT')
     AND NOT has_table_privilege(
       'service_role', relation.oid,
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     AND NOT has_table_privilege(
       'anon', relation.oid,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     AND NOT has_table_privilege(
       'authenticated', relation.oid,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     AND (
       SELECT count(*) = 2
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = relation.oid
         AND trigger_row.tgname IN (
           'reject_legacy_position_history_before_write',
           'reject_legacy_position_history_before_truncate'
         )
         AND trigger_row.tgenabled = 'O'
     )
   ) AS legacy_history_frozen
   FROM guarded_relation
   JOIN pg_catalog.pg_class AS relation ON relation.oid = guarded_relation.relation_oid;

   SELECT count(*) = 2 AND bool_and(
     source.status = 'active'
     AND source.serving_mode = 'shadow'
     AND source.meta->>'rank_visibility_contract' = 'bingx-ranking-quarantine@1'
   ) AS bingx_collection_active_but_rank_shadowed
   FROM arena.sources AS source
   WHERE source.slug IN ('bingx_futures', 'bingx_spot');

   SELECT
     NOT EXISTS (
       SELECT 1 FROM public.leaderboard_ranks
       WHERE source IN ('bingx', 'bingx_futures', 'bingx_spot')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.leaderboard_source_freshness
       WHERE source IN ('bingx', 'bingx_futures', 'bingx_spot')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.leaderboard_count_cache
       WHERE source IN (
         'bingx', 'bingx_futures', 'bingx_spot',
         'bingx_gt0', 'bingx_futures_gt0', 'bingx_spot_gt0'
       )
     ) AS bingx_public_rank_surfaces_empty;

   SELECT count(*) = 4 AND bool_and(convalidated) AS bingx_guards_validated
   FROM pg_catalog.pg_constraint AS guard
   WHERE guard.contype = 'c'
     AND (
       (guard.conrelid = 'arena.sources'::regclass
        AND guard.conname = 'sources_block_unverified_bingx_serving')
       OR (guard.conrelid = 'public.leaderboard_ranks'::regclass
           AND guard.conname = 'leaderboard_ranks_block_unverified_bingx')
       OR (guard.conrelid = 'public.leaderboard_source_freshness'::regclass
           AND guard.conname = 'leaderboard_freshness_block_unverified_bingx')
       OR (guard.conrelid = 'public.leaderboard_count_cache'::regclass
           AND guard.conname = 'leaderboard_count_cache_block_unverified_bingx')
     );

   SELECT count(*) = 1 AND bool_and(
     batch.contract = 'bingx-ranking-quarantine@1'
     AND batch.state = 'COMPLETE'
     AND length(batch.source_rows_before_sha256) = 64
     AND length(batch.archived_rank_sha256) = 64
     AND batch.archived_rank_count = (
       SELECT count(*)
       FROM arena.bingx_rank_quarantine_rows AS archive
       WHERE archive.batch_id = batch.batch_id
     )
   ) AS bingx_archive_complete
   FROM arena.bingx_rank_quarantine_batches AS batch
   WHERE batch.batch_id = '20260804_bingx_rank_authority_quarantine';

   WITH archive(relation_oid) AS (
     VALUES
       ('arena.bingx_rank_quarantine_batches'::regclass),
       ('arena.bingx_rank_quarantine_rows'::regclass)
   )
   SELECT count(*) = 2 AND bool_and(
     relation.relowner = 'postgres'::regrole
     AND relation.relrowsecurity
     AND has_table_privilege('service_role', relation.oid, 'SELECT')
     AND NOT has_table_privilege(
       'service_role', relation.oid,
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = relation.oid
     )
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = relation.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS privilege
       WHERE privilege.grantee <> relation.relowner
         AND (
           privilege.grantee <> 'service_role'::regrole
           OR privilege.privilege_type <> 'SELECT'
           OR privilege.is_grantable
         )
     )
   ) AS bingx_private_archive_acl_exact
   FROM archive
   JOIN pg_catalog.pg_class AS relation ON relation.oid = archive.relation_oid;

   ROLLBACK;
   ```

   `service_role` 对两个 BingX archive 的 SELECT 只用于受控备份/取证，不代表排名
   资格；browser/PUBLIC 必须没有 table、column、policy 或 delegated ACL 路径。
   `bingx_guards_validated=true` 仍不是单独充分证明：同时保存四项
   `pg_get_constraintdef`，逐字比对 `040510` reviewed guard body，防止同名 `CHECK
(true)` 冒充门禁。不要在 production 用真实 `INSERT`、`UPDATE`、`DELETE` 或
   `TRUNCATE` 试探 guard；使用 disposable PG17 fixture 的 delayed-writer、constraint
   tamper、rollback 与 replay 证明。

8. `040510` 后对 `bingx` 与 `bingx_spot` 分别执行 HTTP smoke。`/api/rankings`、
   `/api/traders` 和 `/api/v2/rankings` 的直接 source 请求必须返回受控空集合、所有
   count 为 0、`ranking_visibility=partial`、
   `ranking_visibility_reason=publication_policy_filtered`、
   `ranking_visibility_reasons` 包含 `quarantined_source_requested`，并发送
   `Cache-Control: private, no-store, max-age=0, must-revalidate`。请求 trace 必须证明在
   quarantine short-circuit 后没有 leaderboard、freshness、count-cache 或 Redis 读取；
   `bingx_futures` 物理别名不得成为可请求的 public canonical source。无 source 的公榜
   响应、`availableSources`、`source_freshness`、SSR/sidebars/OG/share/realtime 与 cache
   payload 均不得包含三个 BingX public alias，所有新 cache/tag 必须位于
   `public-rank-policy-v7` epoch；发现旧 v6 命中即失败，不得把旧 payload 重新写入 v7。

9. BingX 隔离是 fail-close 门禁，不是停止采集。不得把 `bingx_futures` 或
   `bingx_spot` 从 active/shadow 提升为 serving，不得直接回填或刷新其 public rank、
   freshness、count/cache surface，不得删除、重命名或放宽四个 guard，不得改写/扩展
   COMPLETE archive ledger，不得给 browser/PUBLIC 或任意非获准 role 增加 archive
   权限，也不得以 fallback、旧 cache、手工 rerank 或临时 ACL 恢复排名。任何 exact
   ledger、archive digest/reconstruction、ACL、guard body、active-shadow、空 surface、
   PostgREST reload、HTTP zero-backend、PG17 replay/rollback 证据失败，立即维持 NO-GO；
   保留 canonical observation、RAW 与采集证据，等待独立 authority review，禁止就地
   “修复”生产数据。

10. Token 侧仍必须固定 `/api/rankings/by-token` 为
    `TOKEN_RANKING_NOT_PUBLISHED`、HTTP 503 和 `private, no-store`，Token 页面不渲染
    旧榜或 unknown 指标。禁止手动调用 `refresh_popular_tokens_mv()`、直接刷新两个旧
    MV、重新启用 `refresh-mv-popular-tokens`、给旧 RPC/MV 补授权，或恢复对
    `public.trader_position_history` 的应用读写。Token 榜只能由后续单独评审的
    authority-snapshot migration 重新开放；新发布器必须从
    `arena.token_trade_fact_authority_shadow` 的 `rank_eligible=true` frozen cohort 构建，
    绑定非 NULL 来源水位，并证明 history、price、cost basis 与 FX 状态全部可信。
    重新开放不得解冻或读取旧 `public.trader_position_history` 档案；未满足这些条件时，
    “保持未发布”本身就是正确的上线结果。

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
cutoff before Phase B. The same bridge must quarantine every legacy history path,
serve warm rows only from the strict verified `@2` authority once installed, and
keep Tier-C preview bounded, partial, cursorless, and ineligible for typed persistence
or ranking.

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
   publisher or cursor, maintenance partition/prune no longer includes legacy
   `position_history`, and legacy/drifted/self-asserted responses remain quarantined.
   A Tier-C response may contain only bounded partial RAW-backed preview rows, with no
   cursor and no typed-history or ranking promotion. Record that SHA with every result.
   Keep both ingest writers stopped and drain all legacy publisher/read/maintenance/
   partition-creator calls, queues, and in-flight transactions. Through ADR-023, follow
   the current file order: `040410` retires legacy application execute, `040420`
   establishes the transitional exact empty/unknown response, `040430` independently
   retires token ranking, `040440` freezes legacy relations and the partition creator,
   `040450` installs immutable RAW/source-run prerequisites, `040500` forward-reopens
   only the reviewed four-argument verified `@2` authority, `040505` limits public
   identity resolution to active serving sources, and `040510` then quarantines
   BingX public-rank authority while preserving active/shadow collection. Prove HMAC first/next-page
   behavior, no-publication empty/unknown, reset-required legacy cursors, and quarantine
   of legacy/drifted/self-asserted payloads. Only after this chain is exact, drain every
   legacy Tier-A queue and re-audit
   `20260729061000_tier_a_execution_claim_enforcement.sql`; apply it alone only if the
   current ledger/live proof shows it missing and its preflight is compatible.
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
   `npm run qa:verified-position-history-pg17`,
   `npm run qa:serving-trader-resolver-pg17`,
   `npm run qa:trader-claim-v2-pg17`, and
   `npm run qa:legacy-portfolio-retirement-pg17`, then verify production ACLs with
   read-only catalog queries, including denial of browser execution and forced
   rollback after a late unlink write. Only after all five identity/credential
   ACL prerequisites, the missing Tier-A postdeploy, all sixteen listed production migrations
   plus the four July ranking-authority prerequisites, their live
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
| **Cron Schedule**    | 55 endpoints / 45 Vercel schedules, staggered        |
| **Scraper PM2 name** | `arena-scraper`                                      |
