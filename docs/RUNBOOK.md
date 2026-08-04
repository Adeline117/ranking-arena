# Arena Operations Runbook

Emergency operations manual for the Arena crypto trader ranking platform.

## Table of Contents

- [Pipeline Failure Troubleshooting](#pipeline-failure-troubleshooting)
- [Leaderboard Anomaly Troubleshooting](#leaderboard-anomaly-troubleshooting)
- [Telegram Alert Response](#telegram-alert-response)
- [Manual Ingest Canary](#manual-ingest-canary)
- [Manual Leaderboard Recompute](#manual-leaderboard-recompute)
- [Arena Score Recalculation](#arena-score-recalculation)
- [Deployment Rollback](#deployment-rollback)
- [Database Emergency Operations](#database-emergency-operations)
- [Common Errors and Solutions](#common-errors-and-solutions)
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

   | Cause                     | Fix                                                                     |
   | ------------------------- | ----------------------------------------------------------------------- |
   | Upstream response changed | Add a sanitized RAW fixture, then update the source adapter parser      |
   | Ingest worker unavailable | Check PM2/container ownership heartbeat and the source execution region |
   | Rate limited (429)        | Inspect attempt evidence and tune the shared transport policy           |
   | Geo-blocked               | Verify the registry-selected region and its configured transport        |
   | Timeout (524/504)         | Inspect source lease/attempt deadlines before changing bounded budgets  |
   | Publish gate rejected     | Inspect completeness, metric parity, and staging rejection evidence     |

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

| Alert Level | Action                                                                      |
| ----------- | --------------------------------------------------------------------------- |
| `info`      | No action needed, informational                                             |
| `warning`   | Monitor -- check within 1 hour. Examples: 0 results returned, slow response |
| `critical`  | Act immediately. Examples: 3+ consecutive failures, database unreachable    |

### Common alert patterns

- **"<platform> consecutive failures 3+"**: Check platform API status, worker attempt evidence, and adapter logs.
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

This recomputes one serving season from canonical `arena_score_inputs` and writes
`leaderboard_ranks`. It does not fetch upstream data and must not be used to
advance `leaderboard_source_freshness.source_as_of`.

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
> **当前硬缺口（2026-07-17）**：`db push --dry-run` 报告 252 remote-only +
> 34 local-only。生产 schema 健康，但仓库历史不能 fresh replay；灾备重建禁止
> 使用裸 `db push` 或 `migration repair --status reverted`。
>
> **2026-08-03 恢复审计**：当前 R2 产物与 restore 行为测试只能证明文件/传输
> 契约，不能证明 managed Supabase 可恢复。`arena+public` plain dump 会包含
> `CREATE SCHEMA public`，fresh PostgreSQL/Supabase 已有 `public`；直接加入 `-n auth`
> 还会与平台管理的 auth DDL/owner 冲突。因此本节当前是取证与恢复开发 runbook，
> 不是已验收的灾备按钮。

**备份是什么**:`backup-to-r2.mjs` 每日 dump `-n arena -n public`(PLAIN SQL,
`--no-owner --no-privileges`)→ gzip → multipart upload → 条件 HEAD 验证，写入
`db-backups/YYYY/MM/arena-backup-<UTC毫秒>-<run-id>-schemas.sql.gz`（schema 产物
保留 14 天）。这是**应用数据备份**，不含 `auth`/`storage`；用户身份当前只有
Supabase 托管 PITR，R2 没有已验证的独立恢复副本。

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

**脚本安全**:`RESTORE_TARGET_URL == DATABASE_URL`(生产)时硬拒绝,除非
`--force-prod`(几乎永远不该用)。缺少 `DATABASE_URL` 生产身份基准时默认硬拒绝；
只有已独立证明 scratch 隔离后才可显式传 `--allow-unverified-target`。

## Deployment Rollback

### 部署管线（2026-07-02 起：CI 门禁部署）

**push main 不再直接触发生产构建。** 流程：push → CI（`ci.yml`）→ 4 个门禁
作业（Pre-flight / Lint & Type / Unit / Build）全绿 → `deploy-gate.yml` 用
Vercel CLI 部署 → 内嵌 smoke（5 URL）→ 失败自动 promote 回滚 + Telegram。
跳过逻辑内联在 `vercel.json` 的 `ignoreCommand`（不要改成依赖 scripts/ 下的
文件——.vercelignore 目录级排除无法负向穿透，会 ENOENT 把全部部署打成 ERROR）。
E2E 被更新 push 折叠取消不影响门禁；CI 红则扣留部署并 Telegram 告警。
Preview/PR 分支构建不受影响。

- **紧急逃生口**：commit message 含 `[deploy-force]` → 跳过 CI 门禁立即
  git 直接构建（走老路径，post-deploy-smoke.yml 兜底）。用后必须在此补记原因。
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
- **彻底停用门禁（回到旧行为）**：revert 掉 `vercel.json` 里的
  `ignoreCommand` 一行即可，git push 立即恢复直接部署。
- **自动回滚 API**：唯一真实端点是
  `POST https://api.vercel.com/v10/projects/{projectId}/promote/{deploymentId}`
  （旧 `/v6/deployments/{id}/promote` 是 404，2026-07-02 实测修正）。

### 排名权威停发与旧历史冻结门禁（待执行）

以下是发布门禁，不是生产执行记录。截至 2026-08-03，仓库已完成迁移和离线
PG17 敌对证明，但没有生产应用证据。任何历史不完整、价格不可信、成本基础未知或
FX 证据缺失的数据必须标记为 `partial/unknown`，不得进入任何排名。

1. 按 ADR-023 仅通过获准的 Supabase MCP `apply_migration` 生产通道核对远端
   migration ledger，并按顺序逐个应用所有缺失文件。每次只能提交一个完整文件，
   不得使用本地 `db push` 或脚本中已禁用的 psql 写命令：
   1. `20260729223000_rerank_public_eligible_rows_only.sql`
   2. `20260729224000_rank_eligible_leaderboard_count_cache.sql`
   3. `20260729225000_token_trader_rank_authority.sql`
   4. `20260729230000_token_ranking_generation_barrier.sql`
   5. `20260804043000_retire_legacy_token_rankings.sql`
   6. `20260804044000_freeze_legacy_position_history_relations.sql`
   7. `20260804045000_quarantine_bingx_rank_authority.sql`

   第五个迁移必须把旧 Token 排名固定为未发布；第六个迁移必须把所有 ledger、
   手工 cutover、分区和保留的 `tph_*` 关系收敛为只读取证档案；第七个迁移保留
   BingX 采集、档案和 RAW 证据，但把 `bingx`、`bingx_futures`、`bingx_spot` 的
   排名、新鲜度和计数面归档后清空，并把两个物理来源留在 active/shadow。任一迁移
   失败、超时、版本缺失或出现对象/权限漂移，立即 No-Go，不得跳过或手工放宽 ACL。

2. 等待相关迁移内的 `NOTIFY pgrst, 'reload schema'` 生效。生产 PostgREST 的唯一
   合法 Token head 是固定的 generation zero；它不能带任何伪造的发布时间或来源
   水位：

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

   非零 `generation_seq`、任一非 NULL 时间字段、任一非零计数，或 head 不可读取都
   是阻断错误。不得把旧 MV 的行数、迁移时间或页面渲染时间补写成可信水位。

3. 通过同一获准数据库通道执行以下只读核验。结果必须全部为 `true`：

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

   ROLLBACK;
   ```

   `service_role` 的 SELECT 只用于受控备份/取证，不代表排名资格；浏览器角色没有
   访问权。不要在生产用真实 `INSERT`、`DELETE` 或 `TRUNCATE` 试探触发器。

4. 应用 smoke 必须确认 `/api/rankings/by-token` 返回稳定的
   `TOKEN_RANKING_NOT_PUBLISHED`、HTTP 503 和 `private, no-store`，Token 页面不渲染
   旧榜或 unknown 指标。以下行为一律禁止：手动调用
   `refresh_popular_tokens_mv()`、直接刷新两个旧 MV、重新启用
   `refresh-mv-popular-tokens`、给旧 RPC/MV 补授权，或恢复对
   `public.trader_position_history` 的应用读写。

5. Token 榜只能由后续单独评审的 authority-snapshot 迁移重新开放。新发布器必须从
   `arena.token_trade_fact_authority_shadow` 的 `rank_eligible=true` 冻结 cohort 构建，
   绑定非 NULL 来源水位，并证明 history、price、cost basis 与 FX 状态全部可信。
   重新开放不得解冻或读取旧 `public.trader_position_history` 档案；未满足这些条件时，
   “保持未发布”本身就是正确的上线结果。

### Vercel instant rollback

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

If a cron job is causing issues, remove or comment it out in `vercel.json` and redeploy:

```bash
# Edit vercel.json, remove the problematic cron entry
git commit -am "disable broken cron: <job-name>"
git push origin main
```

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

| Feature               | Impact                                   | Fallback                                                                     |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Auth (GoTrue)         | Login/signup fails, JWT refresh fails    | Users with unexpired JWTs can still browse public pages                      |
| Database (PostgreSQL) | All API routes returning DB data fail    | Redis cache serves stale data for cached endpoints (rankings, trader detail) |
| Realtime              | Live chat, live leaderboard updates stop | App remains functional, just not live                                        |
| Storage               | Avatar/image uploads fail                | Existing images served from CDN cache                                        |

### Response steps

1. Confirm outage on https://status.supabase.com or Supabase Dashboard > Project Health
2. If total outage (DB unreachable):
   - The app auto-degrades: Redis-cached endpoints continue serving stale data
   - Cron jobs will fail and log errors — this is expected, no manual intervention needed
   - Monitor `pipeline_logs` for mass failures once DB recovers
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

### Fail-open behavior

Redis is non-critical — all Redis consumers fail-open:

| Feature                | Without Redis                                                            |
| ---------------------- | ------------------------------------------------------------------------ |
| Cron distributed locks | Disabled — concurrent cron execution possible (harmless, idempotent)     |
| API cache              | Cache miss → direct DB query (higher latency, more Supabase load)        |
| Rate limiting          | Falls back to in-memory Map (per-instance, less accurate but functional) |
| Alert rate limiting    | Falls back to in-memory Map                                              |

### Response steps

1. Verify status: Upstash Dashboard > your database > Metrics tab
2. No immediate action needed — the app auto-degrades
3. Monitor Supabase connection count (`SELECT count(*) FROM pg_stat_activity`) — without cache, DB load increases
4. If DB connection count exceeds 80% of pool: consider adding `Cache-Control: stale-while-revalidate` headers to high-traffic API routes temporarily

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
| **Cron Schedule**    | 48 endpoints / 40 Vercel schedules, staggered        |
| **Scraper PM2 name** | `arena-scraper`                                      |
