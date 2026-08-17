# Arena V1 Incident Evidence Runbook

Evidence and escalation boundary for the Arena crypto trader ranking platform.

> **Current incident overlay (2026-08-03): NO-GO.**
> [`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md) is
> the launch authority. Generic deploy-force, gate-disable, rollback, migration,
> worker, or cron commands in this runbook do not grant production authorization
> and cannot override that NO-GO. Until the ordered recovery proof is complete
> and the owner explicitly records GO, do not open Beta, restore write workers or
> the paused host backup jobs, or perform an unprotected deployment. Recovery
> migrations remain suspended. Any future exception needs a separately approved
> ADR-023 owner plan; this runbook intentionally contains no production execution
> sequence. Historical owner records may describe former workflow, Vercel, secret,
> host, queue, or deployment state, but they are not live-state evidence. Source
> code and this document cannot prove a provider dashboard, a running worker, a
> deployed schedule, or the contents of a credential store. Only a separately
> approved owner evidence record may establish current external state.

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

1. Do not run a diagnostic just because it is named here: these scripts can contact
   a public endpoint or controlled credentials. Only an owner-approved, exact
   read-only evidence request may be run.
2. Record the commit, release identity, observation time, source, and unavailable
   dependency. A missing heartbeat, unavailable secret channel, or absent source
   witness is unknown, not a healthy result.
3. Use only code/fixture work for the following investigation directions:

   | Observation            | Safe next step                                                        |
   | ---------------------- | --------------------------------------------------------------------- |
   | Exchange payload drift | Reproduce against a redacted fixture; update the current adapter/test |
   | Rate limit or timeout  | Review bounded retry/circuit behavior and source routing in code      |
   | Missing source witness | Record the gate; do not invent a proxy, replay, or data backfill      |
   | Schema mismatch        | Compare types/migrations/catalog under a separate reviewed DB plan    |

Do not SSH to a worker, restart PM2, invoke a cron, alter a proxy, backfill rows,
or generate/apply a fix script from this runbook. Those are separate owner-approved
operations under the V1 NO-GO. The old health, local-recompute, source-fetch,
checkpoint, and legacy-backfill entrypoints covered by the V1 tombstone contract are
RETIRED compatibility paths that exit 2 and cannot be used as an alternate operations
route.

### V1 LCP measurement CLI source boundary

Do not use `scripts/performance/measure-lcp.mjs` as an incident, performance, release,
or deployment workaround. This checked-in legacy compatibility path has no current
operational caller. With every argument, it writes exactly `[RETIRED]
scripts/performance/measure-lcp.mjs` to stderr, leaves stdout empty, and exits `2`.
It does not parse a target, load Lighthouse, access a network, install dependencies,
start or control a browser, or generate, read, overwrite, or upload a report.

This is source-only containment for that one script. It does not change, disable,
inspect, or prove the genuine Lighthouse CI/workflow, other performance tools, Vercel
Analytics, Chrome DevTools, a deployment, browser state, or an already generated report.
Historical performance, CI, target, or report records are not current execution or
external-state evidence. A future measurement, CI, or reporting activity requires an
independently approved ADR-023 owner plan and separate evidence.

### V1 stuck-log diagnostic CLI source boundary

Do not use `scripts/archive/check-stuck-simple.mjs` as an incident, monitoring, or
pipeline workaround. This checked-in legacy diagnostic compatibility path has no
current operational caller. With every argument, it writes exactly `[RETIRED]
scripts/archive/check-stuck-simple.mjs` to stderr, leaves stdout empty, and exits `2`.
It does not read, query, or mutate `pipeline_logs`, or call a current monitoring API,
worker, or meta-monitor.

This is source-only containment for that one script. It does not change, inspect, or
prove `pipeline_logs`, current monitoring APIs, workers, meta-monitor, deployment,
data, or any external state. Historical diagnostic, monitoring, or pipeline records
are not current runtime or data-state evidence. A future diagnostic or remediation
requires an independently approved ADR-023 owner plan and separate evidence. This
boundary does not retire or assess `lib/services/pipeline-logger.ts`,
`/api/health/pipeline`, admin monitoring readers (including enrichment-completeness),
`lib/cron/auto-cleanup-stuck.ts`, or the separately held
`/api/cron/cleanup-stuck-logs`.

### V1 ranking authority cache-purge source boundary

Do not use `scripts/maintenance/purge-ranking-authority-caches.sh` as an incident workaround.
This checked-in compatibility path writes `[RETIRED]` only to stderr and exits `2` for every
argument; it does not read an environment, invoke Vercel or Git, contact a network, clear a
cache, or perform host work.

This is source-only containment. It does not clear, inspect, or prove an already deployed
Data/CDN cache, release, project, or external state, and it does not change public ranking
routes, cache policy, cache keys, or deployment procedure. A future cache operation requires
an independently approved ADR-023 owner plan and separate evidence.

### V1 legacy proxy/import acquisition boundary

Do not use a proxy, a browser scraper, an import script, or a Cloudflare deployment as
a workaround for an unavailable source. The checked-in source hold is limited to these
historical entrypoints: `GET /api/proxy/phemex`, `cloudflare-worker/src/index.ts`,
`scripts/import/import_all_platforms.mjs`, `scripts/import/refresh.sh`,
`scripts/import/import-all-blocked.sh`, `scripts/import/run_hl_enrichment.sh`,
`scripts/vps-deploy/scraper-v16-parallel.js`, `scripts/vps-deploy/arena-proxy.mjs`,
`scripts/archive/test-vps-scrapers.ts`, and
`scripts/archive/verify-data-accuracy.mjs`.

Phemex is auth-first: missing/invalid service authentication returns `401`; valid
authentication returns `410 LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED`; both return the
three `no-store` headers before URL/query parsing, upstream fetch, or logging. The
checked-in Cloudflare Worker returns fixed `410 LEGACY_PROXY_IMPORT_NOT_PUBLISHED` with
the same headers and no upstream fetch. The named scripts report `RETIRED` and exit
`2` before proxy, browser, import, or host work. This is source-only containment, not
an instruction to stop, inspect, restart, or prove an already deployed host, worker,
proxy, queue, or schedule. It does not classify the separately retired `avatar-mirror`
worker or the separate avatar-proxy route below; other avatar-related API paths/helpers,
UI/read RPCs, adapters, and unlisted writers remain outside this runbook's conclusion.

### V1 direct service-auth cron ingress source boundary

Do not invoke the separately bounded direct service-auth cron ingress handlers as an
incident workaround: `GET /api/cron/batch-5min`, `GET
/api/cron/check-data-freshness`, `GET /api/cron/cleanup-data`, `GET
/api/cron/cleanup-stuck-logs`, `GET /api/cron/detect-contracts`, `GET`/`POST
/api/cron/fetch-funding-rates`, `GET`/`POST /api/cron/fetch-market-data`, `GET`/`POST
/api/cron/fetch-open-interest`, `GET /api/cron/qualify-referrals`, and `GET
/api/cron/smoke-test`.

The same fixed, non-environment `V1_CRON_EXECUTION_PUBLISHED=false` source gate is
auth-first for exactly those ten handlers: missing or invalid service authentication
returns `401`; a valid service secret returns `410 CRON_EXECUTION_NOT_PUBLISHED`.
Both responses carry `Cache-Control`, `CDN-Cache-Control`, and
`Vercel-CDN-Cache-Control` `no-store` headers before query/body parsing, locks,
`PipelineLogger`, database, cache, provider, or network work. This source-only list
does not classify other cron routes and cannot stop, inspect, restart, or prove a
deployed scheduler, host, queue, or worker.

### V1 direct rankings-export source boundary

Do not use `GET /api/export/rankings` or its `/api/v1/export/rankings` rewrite alias as an
incident workaround. This direct Edge service-auth export ingress is fixed under the non-environment
`V1_RANKINGS_EXPORT_PUBLISHED=false` source boundary: missing or invalid service authentication returns
`401`; valid authentication returns `410 RANKINGS_EXPORT_NOT_PUBLISHED`. Both responses carry the three
`no-store` headers before query parsing, Redis rate limiting, ranked-cohort reads, CSV/JSON construction,
or logging.

This boundary is limited to that direct ingress. It does not classify the V3 CSV endpoint or authenticated
`/api/settings/export`, and it cannot stop, inspect, or prove an already deployed route, external automation,
cache, or data-reading state.

### V1 legacy Library collector source boundary

Do not use the legacy Library collectors as an incident workaround. The checked-in source hold is limited to
`scripts/library/collect_arxiv.mjs`, `scripts/library/collect_books.mjs`,
`scripts/library/collect_research.mjs`, `scripts/library/collect_whitepapers.mjs`, and
`scripts/library/seed_bulk.mjs`. Each retained path has no import, environment read, database connection, or
fetch path. With any arguments, including under an empty environment, it writes `[RETIRED]` only to stderr,
leaves stdout empty, and exits `2`.

This is source-only containment, not an instruction to stop, inspect, or prove an already deployed collector,
database, schedule, or historical Library data. Other Library helpers, database schema, and historical archive
documentation remain outside this bounded conclusion.

### V1 standalone Flash News CLI source boundary

Do not use the standalone Flash News CLIs as an incident workaround. The checked-in source hold is limited to
`scripts/flash-news/collect.mjs`, `scripts/flash-news/retranslate-all.mjs`,
`scripts/backfill-flash-news-classify.mjs`, `scripts/backfill-flash-news-translate.mjs`,
`scripts/purge-flash-news-noncrypto.mjs`, and `scripts/dedup-hot-posts.mjs`. With any arguments, each retained
path reports fixed `RETIRED` and exits `2`; it does not fetch or mutate a database or file.

This bounded source conclusion does not touch `app/api/cron/flash-news-fetch`, `/api/flash-news`, or the Flash News
UI, and does not change shared classifier/translator runtime behavior; each remains subject to separate review. It is not an instruction to
stop, inspect, or prove any external or already deployed script or scheduler.

### V1 legacy worker deploy source boundary

Do not use `worker/deploy.sh` as an incident workaround. This legacy Mac full-pipeline
compatibility path reports fixed `RETIRED` and exits `2`; it does not install host tooling,
read a worker environment, connect Redis, or alter a process-manager state.

This is source-only containment, not an instruction to stop, inspect, or prove any deployed
worker, host, Redis, process manager, or scheduler. `worker/deploy-ingest-local.sh`,
`worker/deploy-ingest-sg.sh`, their separate safety contracts, and other runtime-ownership
paths remain outside this bounded conclusion.

### V1 social seed CLI source boundary

Do not use `scripts/seed-quality-content.ts` or `scripts/social-seed/generate-posts.ts` as an
incident workaround. These social seed compatibility paths report fixed `RETIRED` and exit `2`
with any arguments; they do not read an environment, fetch, or read/write posts and comments.

This source-only boundary does not change the normal social API, UI, RLS, cache, or existing
posts/comments. It does not stop, inspect, or prove any external cron, deployed script, database,
or historical seed data.

### V1 legacy VPS monitor source boundary

Do not use `scripts/vps/health-ping.sh` or `scripts/vps/healthcheck.mjs` as an incident
workaround. These legacy VPS monitor compatibility paths report fixed `RETIRED` and exit
`2`; they no longer request the network, read or write host files, send alerts, or start
an HTTP server.

This source-only boundary does not stop, inspect, or prove an already deployed host,
process, crontab, UptimeRobot, or external monitor. `/api/health`, OpenClaw, harness,
and infra topology remain outside this bounded conclusion. `scripts/vps-deploy/setup.sh`,
`setup-env.sh`, `check-vps.sh`, and `deploy.sh` are each retired separately.

### V1 legacy VPS bootstrap source boundary

Do not use `scripts/vps-deploy/setup.sh` as an incident workaround. This legacy VPS bootstrap
compatibility path reports fixed `RETIRED` and exits `2`; it does not install software, create host
files, load an environment, or make network requests.

This source-only boundary covers `setup.sh` only. It does not stop, inspect, or prove infra topology,
a deployed host, PM2, credentials, or a scheduler. `setup-env.sh` and `check-vps.sh` are each retired
separately; `scripts/vps-deploy/deploy.sh` is also a retired source path under its own boundary.

### V1 legacy VPS environment provisioning source boundary

Do not use `scripts/vps-deploy/setup-env.sh` as an incident workaround. This legacy VPS
environment-provisioning compatibility path reports fixed `RETIRED` and exits `2`; it no longer
performs its legacy setup work.

This source-only boundary does not stop, inspect, or prove infra topology, a deployed host, PM2,
credentials, or a scheduler. `setup.sh` and `check-vps.sh` are each retired separately;
`scripts/vps-deploy/deploy.sh` is also a retired source path under its own boundary.

### V1 legacy VPS inspection CLI source boundary

Do not use `scripts/vps-deploy/check-vps.sh` as an incident workaround. This legacy VPS inspection
compatibility path reports fixed `RETIRED` and exits `2`; it no longer contacts remote hosts, reads
an environment or logs, checks process state, or makes network requests.

`scripts/vps-deploy/setup.sh`, `scripts/vps-deploy/setup-env.sh`, and
`scripts/vps-deploy/check-vps.sh`, and `scripts/vps-deploy/deploy.sh` are each retired source paths.
This source-only boundary does not stop, inspect, or prove infra topology, deployed hosts, PM2,
credentials, or schedulers.

### V1 legacy VPS deploy CLI source boundary

Do not use `scripts/vps-deploy/deploy.sh` as an incident workaround. This legacy VPS deploy CLI
compatibility path reports fixed `RETIRED` to stderr and exits `2`; it no longer connects to a remote
host, transfers files, changes PM2, or makes health requests.

`scripts/vps-deploy/setup.sh`, `scripts/vps-deploy/setup-env.sh`,
`scripts/vps-deploy/check-vps.sh`, and `scripts/vps-deploy/deploy.sh` are all retired source paths.
This source-only boundary does not stop, inspect, or prove `infra/vps-playwright` ecosystem configs,
deployed hosts, PM2, credentials, schedulers, or worker deploy paths such as `worker/deploy.sh`,
`worker/deploy-ingest-local.sh`, and `worker/deploy-ingest-sg.sh`.

### V1 archive on-chain probe source boundary

Do not use `scripts/archive/test-onchain-apis.mjs` as an incident workaround. This historical
provider-probe compatibility path reports fixed `RETIRED` and exits `2`; it does not contact
Hyperliquid, Aevo, dYdX, Drift, Jupiter, or Graph API endpoints.

This source-only boundary does not change the existing `app/api/trader/onchain-enrich` hold,
worker/on-chain source logic, pages, or evidence paths. It does not stop, inspect, or prove any
deployed probe, host, scheduler, or provider state.

### V1 archive enrich probe source boundary

Do not use `scripts/archive/test-enrich-fix.sh` as an incident workaround. This checked-in
compatibility path writes fixed `[RETIRED]` only to stderr, leaves stdout empty, and exits `2`
for every invocation.

This source-only boundary is limited to that file: it is not a recoverable work route and does
not change, check, or prove any API route, on-chain pipeline, worker, deploy flow, or product
behavior. It cannot establish any external or deployed state.

### V1 enrichment monitor and stale runbook source boundary

Do not use `scripts/monitor-enrichment.sh` as an incident workaround. This historical
compatibility path is a retired V1 NO-GO source path rather than a status monitor; it writes its
fixed `[RETIRED]` notice to stderr, leaves stdout empty, and exits `2`.
`scripts/enrich-onchain-all.mjs` is not present in this repository. The former operational material
in `scripts/DEPLOY_TO_VPS.md` and `scripts/ONCHAIN_ENRICHMENT_README.md` has been replaced by
historical boundary notes and is not a recoverable runbook.

This source-only boundary does not alter, stop, inspect, or prove any application on-chain API,
worker, adapter, deployed host, scheduler, credential, database, provider, historical data, or
product behavior. It does not change the existing `app/api/trader/onchain-enrich` hold and cannot
establish external or deployed state.

### V1 exchange-logo sync source boundary

Do not use `scripts/sync-exchange-logos.sh` as an incident workaround. This single historical
compatibility path is a retired V1 NO-GO source path: with any arguments, it writes `[RETIRED]`
only to stderr, leaves stdout empty, and exits `2`.

This is source-only containment for that file. Existing checked-in
`public/icons/exchanges/*` assets and the product UI that renders their local paths remain in
place and outside this bounded conclusion. It does not download, refresh, delete, inspect, or
prove any deployed asset, cache, external source, or provenance; it also cannot establish that
another logo acquisition or refresh workflow has stopped.

### V1 monthly dependency update source boundary

Do not use `scripts/monthly-deps-update.mjs` as an incident workaround. This no-current-operational-caller
legacy compatibility path is a source-only exit-`2` tombstone: with any arguments, it writes
`[RETIRED]` only to stderr, leaves stdout empty, and does not run `npm audit`, `npm audit fix`,
`npm outdated`, `npm update`, `git checkout`, or `npm install`, or write a dependency-update report.

This boundary does not remove or change the package `security:fix` command, independent CI
`npm audit`, Dependabot, human dependency review, deployed dependencies, or product runtime. It
does not inspect, change, or prove a lockfile, installed package, vulnerability state, release
version, or any external environment. Any future dependency repair, update, or report requires a
separately approved ADR-023 owner plan and distinct evidence; this retired path is not an execution
route.

### V1 avatar-proxy source boundary

Do not use anonymous `GET /api/avatar` or its `/api/v1/avatar` rewrite alias to proxy
an avatar source. Both resolve to the same fixed `410` source-only response with all
three `no-store` headers (`Cache-Control`, `CDN-Cache-Control`, and
`Vercel-CDN-Cache-Control`) before query parsing, DNS lookup, upstream fetch, or
logging. The matching proxy bypass preserves this anonymous response contract only; it
does not authorize upstream proxy use. Registered helpers and known UI/OG consumers no
longer generate that request: a proxy-required origin without a mirror uses local,
inline, or default fallback.

This does not assert zero avatar browser/network activity: existing Supabase mirrors
and direct allowed raw-avatar URLs may still render. Other avatar-related API
paths/helpers, adapters, and unlisted writers remain outside this boundary. This
source-only change cannot clear old CDN cache, stop older deployed code, or prove
external state.

### V1 avatar-backfill source boundary

The canonical `GET /api/cron/backfill-avatars` route and its
`/api/v1/cron/backfill-avatars` rewrite alias resolve to the same source-only tombstone
handler, not a backfill procedure. It authenticates first: missing or invalid service
authentication returns `401`; valid authentication returns `410
CRON_EXECUTION_NOT_PUBLISHED`. Both paths carry the three `no-store` headers and return
before parameter parsing, database access, logging, or upstream fetch. This checked-in
contract does not stop, inspect, restart, or prove a deployed host, external scheduler,
or healthcheck. The separate avatar-proxy route, other avatar-related API paths/helpers,
UI/read RPCs, adapters, and unlisted writers remain outside this handler's bounded
conclusion; the separate `avatar-mirror` worker hold does not expand it.

### V1 avatar-mirror worker source boundary

The checked-in `avatar-mirror` worker execution is separately source-only retired: its
processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a legacy
queued avatar-mirror job returns as a no-op within `route()` before that handler calls
`getConnection()`, acquires its per-job source lease, or loads a processor. This makes
no claim that the surrounding worker or BullMQ has not already established or used
shared Redis, or acquired a job lock. This is not an instruction to stop, inspect,
restart, or prove an already-running worker, Redis, host process, or schedule.
The separate avatar-proxy route, other avatar-related API paths/helpers, UI/read RPCs,
adapters, and unlisted writers remain outside this worker boundary.

### Symptom: Cron job stuck in "running" status

Record the job identity and timestamp through an approved read-only log/catalog
channel. Do not force-close a pipeline row with SQL; that can hide the actual writer
or release failure and is not an authorized remediation.

---

## Leaderboard Anomaly Troubleshooting

### Symptom: Trader with impossibly high ROI

Record the public symptom and request owner-supplied, redacted evidence that ties a
serving row to its source watermark, `source_as_of`, `computed_at`, and a
count-check-PASSED board. `compute-leaderboard` marks deterministic ROI/PnL
corruption with `leaderboard_ranks.is_outlier`; public ranking reads exclude those
rows. Do not query, hand-edit, publish, recompute, or delete data from this
runbook. Reproduce a parser issue only against a committed redacted fixture, then
hand the proposed change and evidence to the owner.

### Symptom: Leaderboard shows stale data

`unknown` means the registry/visible/watermark closure is broken; `stale` or
`critical` means the authority is available and the upstream watermark is genuinely
old. An owner-approved evidence packet should distinguish the independent registry
promise, visible board, `leaderboard_source_freshness.source_as_of`, the last
monitor result, and the last count-check-PASSED source board. Do not call a cron,
authenticated endpoint, service-role RPC, or SQL catalog merely to inspect state.

- Old or missing PASSED evidence is a gate; do not repair a source worker, adapter,
  route, credential, or upstream connection.
- Fresh source evidence but old `source_as_of` is a publication-gate failure; do
  not write a freshness upsert or invoke a recompute.
- Even after fresh upstream data exists, preserve the release gate and escalate.

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

> **V1 evidence boundary:** do not infer Telegram credential, delivery, deployment,
> or alert state from an old local file, this runbook, or a source diff. Do not
> probe, copy, rotate, or test a provider credential. Any future alert restoration
> needs an owner-approved, redacted evidence plan and an exact release identity.

| Alert Level | Action                                                       |
| ----------- | ------------------------------------------------------------ |
| `info`      | Record only; informational                                   |
| `warning`   | Record the symptom and escalate to the owner                 |
| `critical`  | Record the impact/time and immediately escalate to the owner |

### Common alert patterns

- **"<platform> consecutive failures 3+"**: Record the affected public contract;
  do not inspect a proxy, host, or connector runtime.
- **"<platform> returned 0 results"**: Record the response and release identity;
  do not retry, fetch, or schedule a repair.
- **"<platform> slow response"**: Record the bounded symptom; do not inspect or
  alter host/network infrastructure.

---

## Manual Ingest Canary — disabled during V1 NO-GO

The retired `unified-connector`, `batch-fetch-traders`, and `batch-enrich` HTTP
routes must not be used. The historical/design ownership model assigned first-party
collection to region-affine ingest workers, and a canary would create real work rather
than a dry run.

The checked-in fixed `V1_INGEST_EXECUTION_PUBLISHED=false` source hold prevents only
the covered native ingest command path from initiating work: the worker entry exits
before dotenv/runtime dependencies, its scheduler and connection do not begin DB,
ioredis, or BullMQ work, and Tier-C/first-party bridges plus covered direct ingest
scripts admit no new ingest. `POST /api/trader/onchain-enrich` is a fixed `410
INGEST_EXECUTION_NOT_PUBLISHED` response with three `no-store` headers before body,
rate-limit, provider, or serving-data work. Profile `core` and `records` retain warm
serving reads; their cold Tier-C fallback becomes pending before provider/ioredis/
BullMQ/result-queue access. A public route's ordinary rate limiter may still use
Redis, so this is not a "zero Redis reads" assertion.

This source gate cannot stop, inspect, or prove a running host, persisted queue, or
external schedule. The checked-in legacy-refresh boundary, including the client-safe
fixed-false `V1_LEGACY_REFRESH_JOBS_PUBLISHED` marker, separately removes legacy
refresh-job admission and consumption: `batch-discover` is an auth-first `401/410`
tombstone, public trader refresh is an auth-first `401/410` tombstone with no
body/rate-limit/queue work, legacy detail exposes `refresh_job: null`, and
`batch-5min` is separately covered by the bounded direct service-auth cron ingress
hold above. The separately named legacy
proxy/import entrypoints above are source tombstones; do not treat that limited list as
authority to operate, stop, or inspect a proxy/import runtime, or as a claim that every
source write has been closed.

Do not enqueue a canary, read worker credentials, select a region, or inspect a
worker directly from this runbook. A future owner-approved ingest plan must specify
the exact source, region witness, immutable RAW capture, count gate, publication
proof, rollback boundary, and observation window before one controlled canary may be
considered.

---

## Manual Leaderboard Recompute — disabled during V1 NO-GO

The retired `compute-leaderboard` design was a serving-row writer. For the documented
ranking-command chain, the fixed, non-environment
`V1_CRON_EXECUTION_PUBLISHED=false` source gate guards these endpoints:
`GET /api/cron/compute-leaderboard`, `GET /api/cron/precompute-composite`,
`GET /api/cron/sync-meilisearch`, `GET /api/cron/pipeline-evaluate`, and
`GET`/`POST /api/hooks/post-deploy`. Each is auth-first: invalid or missing service
authentication receives `401`; valid authentication receives `410`
`CRON_EXECUTION_NOT_PUBLISHED`; both paths carry three `no-store` headers and end
before parameters, locks, pipeline logs, stores, cache, or provider work. This
ranking-command list does not classify other cron routes.

The separate fixed `V1_RANKING_COMMAND_CHAIN_PUBLISHED=false` source gate closes the
legacy downstream worker/scheduler/caller chain before its dotenv, DB, Redis, BullMQ,
or HTTP work. It does not stop a running process or an externally persisted schedule,
and it is not runtime evidence. None of these direct commands may be invoked manually,
by a cron replay, or through an automation workaround. A score recompute over
unchanged evidence does not advance `leaderboard_source_freshness.source_as_of` and
cannot repair a missing source/publication witness.

Any future recompute requires a separately approved release plan with exact source
evidence, cohort and freshness proof, write target, rollback witness, and post-write
public-contract verification.

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

Do not force an Arena Score or composite recalculation during the V1 NO-GO. It is a
serving write and follows the same separate release-plan requirements as a manual
leaderboard recompute.

Sources: `lib/utils/arena-score.ts`,
`app/api/cron/compute-leaderboard/score-traders.ts`

---

## Restore from R2 backup (灾难恢复)

Historical backup and recovery audits found that artifact presence and local behavior
tests did not establish a complete, compatible recovery path. That conclusion is
kept only as a release gate: the repository has no current recovery witness for
application data, authentication data, access controls, or a managed restore target.
The detailed artifact identifiers, hosts, tools, flags, sizes, and transfer mechanics
are intentionally not reproduced here because they could be mistaken for an
authorized recovery recipe.

The owner historical record placed backup and sentinel automation under a stop hold;
it is not a claim that any schedule or host is currently stopped. V1 source policy
does not authorize a backup schedule, a restore rehearsal, a storage lookup, or use
of a recovery credential.

### Disaster recovery — owner escalation only

If a managed database or backup incident is suspected, record the incident time,
affected service, exact release identity, and the evidence gap, then escalate to
the backup and release owners. Do not inspect PITR, list or retrieve R2 objects,
run a restore tool, choose a target, or attempt a scratch rehearsal from this
runbook.

The checked-in source does not establish that any historical artifact is complete,
compatible, or recoverable. A future recovery plan must first define an isolated
managed target, a catalog/provenance witness, authentication and application-data
coverage, RLS/grant checks, an immutable manifest, a rollback boundary, and owner
GO. Until that plan is separately approved and proven, there is no executable
recovery procedure in this document.

## Deployment Rollback

### 部署管线 — V1 NO-GO（历史状态，不是操作流程）

历史上 CI、Vercel gate、smoke 和 promote 曾构成发布链；该链在 V1 NO-GO 中不能作为
恢复、验证或回滚的快捷路径。任何旧 owner record 对 workflow、Git integration、环境变量、
build 或 bypass 的描述均是历史取证，不是当前控制面状态的断言。

已知 token containment deployment 只说明当时的 fail-closed 语义，不授权后续部署、
迁移、worker restart、backup schedule 恢复或环境变量加载验证。不要使用 deploy-force
标记、改写 `ignoreCommand`、调用 Vercel CLI/API、手动 promote，或把 push 误认为
发布。任何 release/rollback 讨论必须由 release owner 新建受保护计划，明确目标 SHA、
数据库兼容性、别名影响、失败边界与不可变证据；本 runbook 不提供命令、API 路径或
dashboard 点击步骤。

### Credential rotation — V1 NO-GO / owner-only

`scripts/security/rotate-secrets.sh` is RETIRED and exits `2`; it must not be
replaced with an ad hoc CLI, `.env`, shell-history, log, or copied-secret workflow.
No credential may be read, generated, installed, rotated, revoked, or tested from
this runbook during V1 NO-GO.

The retained policy fact is that any future credential change needs a credential
owner, complete consumer manifest, protected source/reviewer boundary, least-privilege
evidence, and an independently approved recovery witness. A missing consumer,
unprotected environment, unknown reload state, or absent negative evidence keeps
the release at NO-GO. Record only an owner-approved credential ID or irreversible
fingerprint—not secret material, connection strings, request headers, or provider
control-plane steps.

Historical credential-containment records are not live credential or environment
state. They must not be used to decide that a provider, environment, or workflow is
safe to change.

### Vercel Deployment Protection bypass status

Do not infer the state or count of any protection bypass from a historical record.
Do not reissue, probe, copy, or test a bypass credential. If future governance ever
permits one, its owner must use a separate protected plan and retain only
non-sensitive proof; this document intentionally has no bypass workflow.

### V1 数据库与排名权威门禁（BLOCKED / owner escalation only）

> **V1 NO-GO：本节不是迁移、部署、edge、worker、queue、cron 或数据库操作手册。**
> 不得据此运行 SQL、`curl`、Supabase/Vercel CLI、迁移 runner、缓存清理、排空、
> worker 控制或任何带生产凭据的探针。只有 owner 在独立 ADR-023 记录中明确批准
> 目标、最小权限执行者、exact candidate SHA、兼容回退边界和证据保全方式后，才可
> 另行建立受控执行计划；该计划不在本 runbook 中。

### Retired migration-ledger repair artifact — V1 NO-GO

`scripts/migration-reconcile/ledger-repair-20260702.sql` 是 `[RETIRED]` 的纯注释历史记录，
不含可运行内容。外部 SQL-file launcher 可能因注释是 no-op 而报告 exit 0；这不是 ledger、catalog、
数据库或任何 live-state 的证据，也不是工作入口。

这是 source-only boundary：它不运行、检查、变更或证明当前数据库、迁移、已部署服务、host、worker
或 scheduler 状态。本 runbook 不提供该历史文件的数据库、MCP、CLI 或回退流程；未来任何 ledger
事项只能由 owner 在独立 ADR-023 中重新定义并保全单独证据。

### V1 ClickHouse schema source boundary

`scripts/clickhouse/schema.sql` 是 `[RETIRED]` 的纯注释来源记录，在 V1 NO-GO 下不含可运行
内容。外部 SQL-file launcher 可能因注释是 no-op 而报告 exit 0；这不是 ClickHouse catalog、数据、
配置或任何 live-state 的证据，也不是验证或工作入口。

这是 source-only boundary：它不调用、配置、变更、检查或证明 ClickHouse client、dual-write、
`PipelineLogger`、deployed ClickHouse instance、host 或 credentials 的状态。本 runbook 不提供该
文件的 CLI 或其他工作流程，也不触及 analytics runtime、已部署实例或控制面。未来任何该类事项
只能由 owner 在独立 ADR-023 中重新定义并保全单独证据。

#### 当前事实

- `V1_EXECUTION_STATUS_2026-08-03.md` 是公开服务与 launch 的唯一权威。
  legacy token-ranking surface 仍是 **ACTIVE-EXPOSURE**，因此继续维持 NO-GO。
- 2026-08-04 的只读审计快照记录为：predeploy manifest `114` 项中 `63 exact /
51 missing`；ranking-authority 及 record/publication 基础链均缺少 live
  apply 证明，`20260716093000` 存在 ledger drift。后续加入的
  `20260804044000_freeze_legacy_position_history_relations.sql` 同样没有 apply
  证明，须在未来独立只读复核中重新裁定。该历史快照不能被解释成任何文件的 apply
  授权。
- 旧 Token 公开面、legacy position-history、Tier-A writer/queue、凭据连接、
  Portfolio 与 claim 路径都必须保持 fail closed。历史 owner 记录把两台 ingest writer
  置于 stop hold；这不是其当前运行状态的证明，本 runbook 也不授权启动、停止或恢复它们。
  不得通过手动 refresh、重放、ACL 放宽、补写 ledger、重新启用 cron 或恢复旧 writer
  来“修复”门禁。

#### 保留的架构/风险结论（非执行顺序）

V1 的未来恢复设计需要同时覆盖 ranking authority、token-ranking retirement、
record/publication provenance、legacy position-history quarantine、activation、
authorization、legacy Portfolio retirement 与 Claim 两阶段 cutover。它们相互依赖，
不得批量重放、跳过 manifest drift、用 `db push` 替代审计，或把停止 writer 误作
schema/ACL 已验证。

任何未来 owner 方案必须先独立证明：公开 token 面维持 fail closed；完整 manifest、
ledger 与 live catalog 可兼容；所有身份/凭据 ACL 前置可验证；候选版本与数据库契约
存在可审计的 exact-SHA 关系；以及无遗留 writer、queue、transaction 或公开 reader
仍可触达退役面。失败、漂移、未知凭据、未知 host 状态或证据缺口都保持 NO-GO。

本 runbook 只保留下列 inventory，避免把历史文件名误读为可复制的执行队列：

- record/publication：`20260803090000`、`20260803100000`、`20260803101000`；
- activation、authorization、Portfolio、Claim：`20260803211000` 至
  `20260803214000`；
- legacy position-history / token-ranking containment：`20260804041000`、
  `20260804042000`、`20260804043000`、`20260804044000`；
- Tier-A postdeploy 及 ranking-authority 依赖仍需由 owner 对照完整 manifest
  单独裁定。

如需升级，先记录影响的公开 contract、时间、release identity 和非敏感证据，随后
交由 database/release owner 建立新的 ADR-023。不要在本文件、终端历史、issue 或
自动化日志中粘贴 credential、连接串、SQL、HTTP 请求或控制面步骤。

### Vercel release, rollback, and scheduler control — V1 NO-GO

Do not use Vercel CLI, dashboard, API, deployment aliases, promotion, rollback,
schedule enable/disable, or a source push as an incident response. This applies
equally to a suspected bad deployment and a suspected cron loop. Record the
public symptom, release identity, time, affected contract, and non-sensitive
evidence; then escalate to the release owner. A future owner-approved control-plane
plan must prove target/database compatibility and recovery witnesses before any
action. No command or dashboard recipe is retained here.

---

## Database Emergency Operations — V1 NO-GO

This runbook does not authorize SQL against production. Do not inspect or change
connections, terminate/cancel backends, run maintenance, `VACUUM`, replay a
migration, alter ACLs, or use a service credential from these instructions.
A high connection count, slow query, bloat signal, or suspected lock is an
owner-escalation event: preserve a redacted symptom/timestamp/release record and
request a separately reviewed database incident plan. That plan must name its
read-only evidence boundary, exact target, rollback/recovery witness, and
responsible owner before it contains any query.

**Historical retention rule:** never treat deletion of daily snapshots, equity
curves, or timeseries as routine remediation. They remain forensic evidence and
are not publication authority.

### Daily-snapshot containment gate

`aggregate-daily-snapshots`, `cleanup-violations`, and `scan-data-quality` remain
unscheduled auth-first 401/410 tombstones. Do not invoke a legacy backfill, cleanup,
scan, general-purpose SQL RPC, retired Vercel schedule, or `exec_sql` path. Recent
rows and nonzero counts do not prove trustworthy history: `trader_daily_snapshots`
lacks season, generation, cohort, and publication-proof identity, so Movers and all
derived public consumers remain fail closed.

`20260808090000_quarantine_legacy_trader_daily_snapshots.sql` is retained source
inventory only. It is not self-executing and must not be applied, simulated against
production, or used to infer live state from this runbook. A future database owner
plan must independently establish catalog/ACL evidence and preservation requirements
before any protected migration process is considered.

## Trader claim V2 two-phase cutover — V1 NO-GO

This section preserves the cutover design and risk conclusions, not a production
recipe. Claim availability, bridge deployment, authorization changes, Portfolio
retirement, migration execution, production QA, type generation, API smoke, and
catalog queries are all suspended unless an owner separately records GO.

### Retained design facts

- Phase A intentionally leaves both legacy and V2 approval unavailable; it is not
  a backwards-compatible approval path.
- Phase B is the only design stage that closes legacy claim writers and establishes
  the canonical V2 activation/unlink boundary. Therefore the legacy application is
  not a valid claim-path rollback target after a future Phase B.
- Any eventual bridge must preserve a fail-closed public contract, quarantine legacy
  position-history reads, and have an auditable exact-SHA relation to its database
  contract. A stopped worker or a passing local test does not prove a live cutoff.
- V1 wallet claims are limited to Hyperliquid and GMX in the design; CEX API keys
  must never create a claim, verified badge, or public first-party publication.

### Owner escalation requirements

A future proposal must be an independently approved ADR-023/release plan rather
than a continuation of this runbook. It must define the exact candidate, staged
disposability proof, immutable evidence, ACL/ledger/catalog compatibility, writer
and queue containment, claim/authorization/Portfolio data-retention impacts,
failure boundary, and recovery witness. No plan may infer any of these from
historical migration names, a service credential, an old deployment, a local
generated type, or a prior incident result.

All verified historical claims are retained pending owner audit; no automated
delete, downgrade, rebind, credential revocation, or identity guess is authorized.
Unprovable, duplicate, conflicting, or incomplete identity evidence keeps V1
NO-GO. `lib/supabase/database.types.ts` remains production-generated **DO NOT
EDIT** until a separately authorized schema lifecycle produces a verified diff.

---

## Common Errors and Solutions

| Signal                | Possible cause                                   | V1 response                                                   |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `42P10` in upsert     | Missing unique constraint on ON CONFLICT columns | Record the mismatch; owner reviews an isolated migration plan |
| `PGRST301`            | JWT expired or invalid                           | Record a redacted auth failure; do not inspect/copy secrets   |
| `524` from Cloudflare | Request took > 100s                              | Preserve a fixture and performance evidence for code review   |
| `401` from VERCEL_URL | Deployment protection blocks internal calls      | Record the contract; do not alter deployment protection       |
| `429` from exchange   | Rate limited                                     | Preserve source evidence; do not alter routing or VPS proxy   |
| `CircuitOpenError`    | Too many consecutive failures                    | Observe fail-closed behavior; do not force a retry            |
| Redis `WRONGTYPE`     | Key type mismatch from old data                  | Escalate; do not delete or rewrite cache state                |
| Build OOM             | Not enough memory                                | Use isolated local build evidence; no production change       |

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

1. Confirm the vendor incident through its official status page and record the
   observation time, release identity, affected public contract, and evidence source.
2. Continue the incident **NO-GO**. Unproven cache data must be unavailable, not
   reported healthy; a row count, stale log, or assumed worker state is not proof.
3. Preserve any owner-supplied read-only evidence without copying secrets. This
   runbook itself does not authorize a check or a production query.
4. Do not restart/stop a worker, invoke a cron, alter a feature flag, change a
   Vercel/Supabase control-plane setting, or attempt PITR from this runbook. Those
   are high-impact operations requiring a separately reviewed incident plan, explicit
   owner authorization, and verified rollback/recovery witnesses.

---

## Redis (Upstash) Outage

### Mixed fail behavior

Redis consumers do **not** share one fail-open contract. Treat each boundary separately:

| Feature                             | Without Redis                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical public rankings           | Serve only a publication-matched, sanitized LKG when one remains available; otherwise return unavailable/503. Never bypass the canonical contract with a direct DB query. |
| Wallet Claim challenge/replay nonce | Fail closed with 503 and `Retry-After`; no in-memory nonce fallback and no claim submission while replay coordination is unavailable.                                     |
| General API rate limiting           | May fall back to an in-memory per-instance limiter, which is less accurate and must not be treated as a distributed guarantee.                                            |
| Cron/alert locks and deduplication  | Follow the consumer-specific contract; do not retry or replay a job during V1, and never assume duplicate execution is harmless.                                          |

### V1 evidence-only response

Record the public symptom, time, release identity, and non-sensitive public
contract evidence. Canonical data needs a valid publication generation; an LKG
must be explicitly stale, and no valid LKG is unavailable rather than a direct
database fallback. Keep wallet claims unavailable while replay coordination is
unavailable. Do not access the Upstash control plane, replay a cron/alert,
rewrite cache state, stop a loop, or issue a new wallet challenge from this
runbook; those require separately approved owner handling.

---

## Stripe Webhook Outage / Backup — V1 NO-GO

Stripe webhook delivery is an owner-controlled external write surface. Do not use
the dashboard, Stripe CLI, event resend, endpoint disable/enable, application
deployment, database deduplication table, or session verification route from this
runbook. Do not paste event payloads, customer data, endpoint identifiers, or
credentials into incident notes.

The retained design fact is that `stripe_events` is intended to deduplicate webhook
processing with 30-day retention; that claim is not live proof and must not justify
a replay. Record only a redacted symptom, time window, public user impact, and
provider event reference supplied by the responsible owner. Any recovery or replay
requires a separately approved payments incident plan with idempotency, customer
impact, release, and rollback witnesses.

---

## Key Infrastructure — V1 scope registry

This table deliberately excludes host addresses, ports, project IDs, service names,
and scheduler targets. Those identifiers are not an authorization to access a
control plane.

| Surface                 | Current V1 handling                                                             |
| ----------------------- | ------------------------------------------------------------------------------- |
| Supabase production     | Owner-held; no direct SQL, migration, or control-plane access from this runbook |
| Vercel production       | Deployment, promotion, rollback, environment, and scheduler actions suspended   |
| SG / Japan ingest hosts | Owner-recorded stop hold; not live proof; no SSH, PM2, proxy, or cron action    |
| Cloudflare Worker       | Owner-held; no deploy or routing action                                         |
| Public site             | Public, non-authenticated observation only; not a release signal                |
| Schedules               | Checked-in source has no Vercel schedules; no enable/disable/replay action      |
