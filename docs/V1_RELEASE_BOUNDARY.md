# V1 Release Boundary

This document holds the V1 release-boundary notes that previously lived in the
repository README. It describes source-level publication holds and the operating
boundary for the gated pre-release; it is not evidence of deployed state.

## V1 NO-GO boundary

V1 work is limited to local development, isolated branches, and Draft PR review.
Production services, dashboards, hosts, schedulers, workers, and credentials are
owner-controlled. An agent or contributor may collect production evidence only when
the owner explicitly approves the exact read-only query; no approval authorizes a
write, deployment, migration, cache action, cron invocation, restart, or recovery.

The checked-in V1 source configuration has **zero Vercel schedules** and disables
Git-triggered Vercel deployment. These are source-only containment changes: they do
not prove or modify a deployed control plane. Historical route implementations are
code-review context only and do not authorize an operation.

This source revision also has narrow, immutable publication holds; none is an
environment toggle or a claim about a deployed process:

- For the documented ranking-command chain, `V1_CRON_EXECUTION_PUBLISHED=false`
  guards five direct endpoints: `GET /api/cron/compute-leaderboard`,
  `GET /api/cron/precompute-composite`, `GET /api/cron/sync-meilisearch`,
  `GET /api/cron/pipeline-evaluate`, and `GET`/`POST /api/hooks/post-deploy`. Each
  authenticates before doing work: missing or invalid service authentication returns
  `401`; valid authentication returns `410` with `CRON_EXECUTION_NOT_PUBLISHED`; both
  responses carry the three `no-store` headers before request parsing, locks, pipeline
  logs, stores, cache, or provider access. This ranking-command list does not classify
  other cron routes.
- The same fixed, non-environment `V1_CRON_EXECUTION_PUBLISHED=false` source gate
  separately holds exactly ten direct service-auth cron ingress handlers: `GET
/api/cron/batch-5min`, `GET /api/cron/check-data-freshness`, `GET
/api/cron/cleanup-data`, `GET /api/cron/cleanup-stuck-logs`, `GET
/api/cron/detect-contracts`, `GET`/`POST /api/cron/fetch-funding-rates`, `GET`/`POST
/api/cron/fetch-market-data`, `GET`/`POST /api/cron/fetch-open-interest`, `GET
/api/cron/qualify-referrals`, and `GET /api/cron/smoke-test`. Each authenticates
  first: missing or invalid service authentication returns `401`; a valid service
  secret returns `410 CRON_EXECUTION_NOT_PUBLISHED`. Both paths carry
  `Cache-Control`, `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` `no-store`
  headers and return before query/body parsing, locks, `PipelineLogger`, database,
  cache, provider, or network work. This bounded direct-ingress list does not classify
  other cron routes and cannot stop, inspect, or prove an existing deployed scheduler,
  host, queue, or worker.
- `V1_RANKING_COMMAND_CHAIN_PUBLISHED=false` separately closes the checked-in legacy
  downstream ranking-command worker, scheduler, and caller chain. On this source
  revision its worker entry exits before dotenv, database, Redis, BullMQ, or HTTP
  initialization, and its scheduler/caller paths return before BullMQ, Redis, or
  network work. It cannot stop an already-running host process or a schedule stored
  outside this checkout.
- `V1_INGEST_EXECUTION_PUBLISHED=false` holds the checked-in native ingest command
  path: its worker entry exits before dotenv/runtime dependency initialization, and
  its scheduler and Redis connection do not start database, ioredis, or BullMQ work.
  The Tier-C and first-party bridges admit no new ingest work; `POST
/api/trader/onchain-enrich` is a fixed `410 INGEST_EXECUTION_NOT_PUBLISHED` response
  with three `no-store` headers before body parsing, rate limiting, provider, or
  serving-data work. Profile `core` and `records` retain their warm serving-read
  branches, while the cold Tier-C fallback resolves as pending without initializing a
  provider/ioredis/BullMQ bridge or reading a Tier-C result queue. Their public rate
  limiter may still use Redis; this hold is not a claim that those routes make zero
  Redis reads. Covered direct ingest scripts likewise do not initiate ingest. This
  source boundary neither stops nor proves a running host, persisted queue, or
  external schedule.
- `V1_REFERRAL_PROGRAM_PUBLISHED=false` separately holds `GET`/`POST
/api/referral` and `POST /api/referral/apply`. They authenticate first: missing or
  invalid authentication returns `401`; an authenticated account receives `410
REFERRAL_PROGRAM_NOT_PUBLISHED`. Both responses carry `Cache-Control`,
  `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` `no-store`, before endpoint
  query/body parsing, rate limiting, referral-code issuance, or endpoint-specific
  referral reads/writes. The same source hold leaves `/referral`, Settings, pricing
  success, and rank-share referral propagation status-only; historic referral data is
  not an automatic-reward promise. This is source-only and does not stop, inspect, or
  prove deployed code, historical records, or external reward state.

The checked-in legacy-refresh boundary, including the client-safe fixed-false
`V1_LEGACY_REFRESH_JOBS_PUBLISHED` marker, holds the legacy `refresh_jobs` path.
`batch-discover` is auth-first `401/410` with three
`no-store` headers. `batch-5min` is separately covered by the bounded direct
service-auth cron ingress hold above. The public trader-refresh POST is auth-first
`401/410` without parsing a body, rate limiting, or touching the queue; legacy detail
returns `refresh_job: null`, and its compatibility hook neither posts nor polls.
This source boundary cannot stop or prove a running host, persisted queue, or external
schedule.

The checked-in legacy proxy/import acquisition boundary is deliberately narrower than
"all source writes are closed." It retires only these historical source entrypoints:
`GET /api/proxy/phemex`, `cloudflare-worker/src/index.ts`,
`scripts/import/import_all_platforms.mjs`, `scripts/import/refresh.sh`,
`scripts/import/import-all-blocked.sh`, `scripts/import/run_hl_enrichment.sh`,
`scripts/vps-deploy/scraper-v16-parallel.js`, `scripts/vps-deploy/arena-proxy.mjs`,
`scripts/archive/test-vps-scrapers.ts`, and
`scripts/archive/verify-data-accuracy.mjs`. The Phemex route authenticates first:
missing or invalid service authentication returns `401`; valid authentication returns
`410 LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED`; both responses carry three `no-store`
headers before URL/query parsing, upstream fetch, or logging. The checked-in
Cloudflare Worker returns fixed `410 LEGACY_PROXY_IMPORT_NOT_PUBLISHED` with the same
three `no-store` headers and no upstream fetch. The listed script entrypoints report
`RETIRED` and exit `2` before proxy, browser, import, or host work. This is source-only:
it neither stops nor proves an already deployed Cloudflare Worker, VPS proxy/scraper,
host process, queue, or schedule. That proxy/import unit does not classify or close
the separately held `avatar-mirror` worker or the separate avatar-proxy route below.
Other avatar-related API paths/helpers, UI/read RPCs, adapters, and unlisted writers
remain outside its bounded review.

A separate V1 avatar-proxy source hold covers anonymous `GET /api/avatar` and its
`/api/v1/avatar` rewrite alias. Both resolve to the same fixed `410` response with
`Cache-Control`, `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` `no-store`
headers before query parsing, DNS lookup, upstream fetch, or logging. The matching
proxy bypass preserves that anonymous no-store response contract; it is not an
upstream-proxy permission. Registered helpers and known UI/OG consumers no longer
generate a proxy request: a proxy-required origin without a mirror falls back to
local, inline, or default behavior. This does not say all avatar browser/network
activity is zero: existing Supabase mirrors and direct allowed raw-avatar URLs may
still render, and other avatar-related API paths/helpers, adapters, and unlisted
writers remain outside this boundary. This source-only change cannot clear an old CDN
cache, stop older deployed code, or prove external state.

A separate source-only tombstone covers the canonical `GET /api/cron/backfill-avatars`
route and its `/api/v1/cron/backfill-avatars` rewrite alias, which resolves to the same
handler. It is auth-first: missing or invalid service authentication returns `401`; valid
authentication returns `410 CRON_EXECUTION_NOT_PUBLISHED`. Both responses carry the
three `no-store` headers and return before parameter parsing, database access, logging,
or upstream fetch. This endpoint contract cannot stop, inspect, or prove an already
deployed host, external scheduler, or healthcheck. The handler itself does not cover
the separate avatar-proxy route, other avatar-related API paths/helpers, UI/read RPCs,
adapters, or unlisted writers; the separate `avatar-mirror` worker hold below does not
expand that handler's scope.

The checked-in V1 `avatar-mirror` worker execution is separately source-only retired:
its processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a
legacy queued avatar-mirror job returns as a no-op within `route()` before that handler
calls `getConnection()`, acquires its per-job source lease, or loads a processor. This
makes no claim that the surrounding worker or BullMQ has not already established or
used shared Redis, or acquired a job lock. It cannot stop, inspect, or prove an
already-running worker, Redis, host process, or schedule.
It does not expand the separate avatar-proxy boundary or classify other avatar-related
API paths/helpers, UI/read RPCs, adapters, or unlisted writers.

## Data API access during V1

The endpoint names below are API-contract reference only, not V1 operational checks.
Calling any production endpoint requires the owner's prior, query-specific read-only
approval.

**5 published endpoints**: `rankings`, `trader`, `search`, `platforms`, `bulk`.
The `history` compatibility endpoint is currently a no-store 503 quarantine response and does not consume API quota.

API-key issuance and live API documentation access are owner-controlled during V1.

## Data Pipeline

The checked-in V1 source configuration contains **0 Vercel schedules**. The
repository's 53 cron/worker route implementations are not operational authority,
evidence of deployment, or permission to invoke a route. This source-only
containment deliberately makes no claim about any deployed control plane or host.

**Daily-snapshot and trader-alert containment.** `aggregate-daily-snapshots`, `cleanup-violations`, and `scan-data-quality` are unscheduled auth-first tombstones: anonymous requests return 401 and authenticated requests return 410 without touching data. The scanner's former admin RPC has no versioned function body, so it is not accepted as a read-only replacement. Legacy daily rows have no season, generation, cohort, or publication-proof identity and are not ranking authority. Movers, equity, indicators, public history, V3 history, and hot-trader recommendations now return fixed empty/unavailable, three-layer `no-store` contracts; the homepage does not request Movers, and the equity hook rejects old cached positive bodies without explicit availability plus publication proof. Trader-alert evaluation, personalized trader-event broadcasts, ranking-change triggers, and weekly digests are retired auth-first tombstones: authenticated callers receive a fixed 410 response and must not read trader data, advance alert state, or deliver email/push. V1 does not authorize manual backfill, cleanup, general-purpose SQL RPC, restoration of a retired schedule, or reopening alert delivery; any future design must be separately reviewed and provenance-bound.

The forward migrations `20260808090000_quarantine_legacy_trader_daily_snapshots.sql` and `20260816130000_quarantine_v1_trader_alert_browser_mutations.sql` are reviewed deployment candidates, not proof that the live database has these ACLs. They are not to be applied, verified against production, or used to infer live state during V1 NO-GO. Any future release requires a separately recorded owner GO and a bounded release plan.

### V1 scheduled work and monitoring

V1 authorizes no scheduled maintenance, fetch, cleanup, backfill, notification, or
recovery work. The checked-in Vercel configuration has zero schedules; separate
disabled workflow triggers and any external scheduler are not evidence of an approved
runtime. Monitoring integrations are report-only source interfaces. This does not
establish whether any external scheduler, host worker, or provider pipeline is
running. Collect production evidence only after the owner approves the exact read-only
query; never turn an observation into a route invocation, task, mutation, or automatic
fix.

## Diagnostic Scripts

The named `check:*` diagnostics may contact public services or controlled read
credentials; they are not default local commands. Obtain the owner's prior approval
for the exact read-only evidence query before running one. Inventory results do not
authorize a backfill, cron invocation, migration, cache action, or production repair.
The legacy paths covered by the V1 tombstone contract (old health, local-recompute,
source-fetch, checkpoint, and legacy-backfill entrypoints) are compatibility
tombstones: they report `RETIRED` and exit 2, so they are not current diagnostic
evidence.

## Development and review workflow

Use an isolated branch or worktree, make and verify the local code change, then open
a Draft PR for review. A branch push, local build, preview, approval, or merge does
not authorize a production operation or establish deployed state.

## Deployment

Production release is currently suspended by the V1 NO-GO in
[`docs/RUNBOOK.md`](./docs/RUNBOOK.md). A pushed commit, preview, or local build is
not proof that production advanced. Do not invoke a manual production deployment,
migration, cache purge, or release promotion without the separately recorded owner
GO and release gates.

Production environment configuration and hosting control planes are owner-managed
and outside this guide. Do not open or alter them as part of V1 development.

### Scheduled jobs

The checked-in V1 source configuration contains **0 Vercel schedules**. This is not
a statement that a deployed control plane has changed. Do not invoke, alter, add, or
inspect a scheduler except through an owner-approved, exact read-only evidence
request.

### Infrastructure

| Component                  | V1 boundary                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Vercel**                 | Owner-controlled; no deployment or control-plane action                        |
| **Managed services**       | No direct operation; only owner-approved, exact read-only evidence             |
| **OpenClaw compatibility** | Observation only; no auto-fix or release authority during V1 NO-GO             |
| **Source routing code**    | Local review only; no proxy, worker, or host operation from this documentation |

### Monitoring

- Owner-approved, query-specific read-only evidence only (for example
  `npm run check:freshness` for the published ranking freshness authority)
- Local test output and code review do not establish production state
- Alerts and monitors are observations, not remediation authority

### Key Metrics

| Metric                            | Value                 |
| --------------------------------- | --------------------- |
| Ingest Adapters                   | 26 registered         |
| Cron/worker route implementations | 53 (not V1-scheduled) |
| V1 Vercel schedule plan           | 0                     |
| UI Languages                      | 4 (en/zh/ja/ko)       |
