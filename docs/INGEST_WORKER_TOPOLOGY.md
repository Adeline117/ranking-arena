# Ingest Worker Topology and Ownership — V1 NO-GO

This document records the checked-in worker topology and future release design.
It does not authorize a production worker deployment, restart, source fetch, cron,
or host access. No worker operation is authorized under the V1 incident hold; live
state must be established only through a separately approved owner inventory. Only
a separately recorded owner GO and reviewed release plan can authorize a host-side
operation.

## Checked-in V1 ingest source hold

`V1_INGEST_EXECUTION_PUBLISHED=false` is a fixed checked-in source boundary, not an
environment switch. It holds the native ingest command path: `worker/src/ingest-worker.ts`
exits before dotenv/runtime dependency initialization; the scheduler and Redis connection
end before DB, ioredis, or BullMQ work; Tier-C and first-party bridges admit no new
ingest; and the covered direct ingest scripts do not initiate work. `POST
/api/trader/onchain-enrich` is a fixed `410 INGEST_EXECUTION_NOT_PUBLISHED` response
with three `no-store` headers before body parsing, rate limiting, provider, or
serving-data work.

The public profile `core` and `records` routes retain their warm serving-read branches.
When they need Tier-C, the held bridge returns pending before bridge-provider, ioredis,
BullMQ, or result-queue access. Their general public rate limiter may still use Redis,
so this does not mean those routes make no Redis reads. The gate is source-only: it
does not stop, inspect, or prove a running host, queue, or external schedule.
The checked-in legacy-refresh boundary, including the client-safe fixed-false
`V1_LEGACY_REFRESH_JOBS_PUBLISHED` marker, separately retires legacy queue admission
and consumption: `batch-discover` is auth-first `401/410`, `batch-5min` retains only
post hot-score maintenance, and public refresh never admits or exposes a job. Legacy
proxy/import paths remain outside that refresh-job containment unit.

The separate legacy proxy/import source hold is intentionally limited to `GET
/api/proxy/phemex`, `cloudflare-worker/src/index.ts`,
`scripts/import/import_all_platforms.mjs`, `scripts/import/refresh.sh`,
`scripts/import/import-all-blocked.sh`, `scripts/import/run_hl_enrichment.sh`,
`scripts/vps-deploy/scraper-v16-parallel.js`, `scripts/vps-deploy/arena-proxy.mjs`,
`scripts/archive/test-vps-scrapers.ts`, and
`scripts/archive/verify-data-accuracy.mjs`. Phemex authenticates first, then returns
fixed `410 LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED` with three `no-store` headers;
there is no URL/query parsing, upstream fetch, or logging after the hold. The checked-in
Cloudflare Worker returns fixed `410 LEGACY_PROXY_IMPORT_NOT_PUBLISHED` with the same
headers and no upstream fetch. The named scripts report `RETIRED` and exit `2` before
proxy, browser, import, or host work. This does not stop, inspect, or prove a deployed
VPS proxy/scraper, Cloudflare Worker, host process, queue, or external schedule. It
does not include the separately retired `avatar-mirror` worker or the separate
avatar-proxy route below. Other avatar-related API paths/helpers, UI/read RPCs,
adapters, and unlisted writers remain outside this proxy/import review.

A separate V1 avatar-proxy source hold covers anonymous `GET /api/avatar` and its
`/api/v1/avatar` rewrite alias. Both resolve to the same fixed `410` response with all
three `no-store` headers (`Cache-Control`, `CDN-Cache-Control`, and
`Vercel-CDN-Cache-Control`) before query parsing, DNS lookup, upstream fetch, or
logging. The matching proxy bypass only preserves that anonymous response contract; it
does not authorize an upstream proxy. Registered helpers and known UI/OG consumers no
longer generate proxy requests: a proxy-required origin without a mirror uses local,
inline, or default fallback. This is not a claim that avatar browser/network activity
is zero: existing Supabase mirrors and direct allowed raw-avatar URLs may still render,
while other avatar-related API paths/helpers, adapters, and unlisted writers remain
outside. This source-only change cannot clear old CDN cache, stop older deployed code,
or prove external state.

The canonical `GET /api/cron/backfill-avatars` route and its
`/api/v1/cron/backfill-avatars` rewrite alias resolve to the same source-only
tombstone handler. It authenticates first: missing or invalid service authentication
returns `401`; valid authentication returns `410 CRON_EXECUTION_NOT_PUBLISHED`. Both
responses carry three `no-store` headers and return before parameter parsing, database,
logging, or upstream fetch. This is not evidence that a host, external scheduler, or
healthcheck is deployed, stopped, or healthy. The separate avatar-proxy route, other
avatar-related API paths/helpers, UI/read RPCs, adapters, and unlisted writers remain
outside this handler's bounded review; its separate `avatar-mirror` worker hold does
not change that route scope.

The checked-in `avatar-mirror` worker execution is separately source-only retired: the
processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a legacy
queued avatar-mirror job returns as a no-op within `route()` before that handler calls
`getConnection()`, acquires its per-job source lease, or loads a processor. This makes
no claim that the surrounding worker or BullMQ has not already established or used
shared Redis, or acquired a job lock. It cannot stop, inspect, or prove an
already-running worker, Redis, host process, or schedule. It does not classify
the separate avatar-proxy route or other avatar-related API paths/helpers, UI/read
RPCs, adapters, or unlisted writers.

Arena's ingest fleet is designed to serve customer-facing ranking freshness from two
nodes sharing one Supabase database and Upstash Redis. A source's
`arena.sources.fetch_region` selects a region-affine BullMQ queue.

| Logical node  | Historical PM2 identity  | Required regions | Runtime target |
| ------------- | ------------------------ | ---------------- | -------------- |
| Mac Mini      | `arena-ingest-worker`    | `local`          | Owner-managed  |
| Singapore VPS | `arena-ingest-worker-sg` | `vps_sg`         | Owner-managed  |

The Mac owns local sources. SG owns geo-blocked CEX sources assigned to `vps_sg`.
As verified on 2026-07-24, `vps_jp` has no source, queued job, browser endpoint,
or runtime owner; do not advertise it in `INGEST_REGIONS`. Reintroducing it
requires one explicit owner plus a proven browser endpoint and a coordinated
source/queue migration. A required region must have exactly one logical owner;
neither missing, duplicate, nor combined-region owners are healthy.

## Runtime ownership boundary

Runtime directories, host identities, secrets, PM2 state, deployment markers, and
release IDs are private owner-managed evidence. They are deliberately not a
copy/paste host-access recipe. Do not infer worker ownership from a repository path,
Git state, or this document; do not SSH or run PM2 inspection commands. When a
release window is formally reopened, the owner must capture the current runtime
inventory and publish a new approved procedure.

## Future SG deployment topology (not an instruction)

The historical **Deploy Ingest Worker (SG)** workflow and
`worker/deploy-ingest-sg.sh` are not runnable deployment channels during V1. Do
not use their normal or `--dry-run` forms from this document. When the NO-GO is
lifted, the release owner must re-evaluate the exact target SHA, protected
environment, source-trust boundary, and current host evidence before publishing a
new approved procedure.

The former cutover design required a complete candidate, a unique runtime owner,
fresh ready/SHA/release-ID evidence, and a recoverable failure path. It is retained
only as design context, not as an executable procedure. Do not follow an older
deployment document while the V1 NO-GO is in force.

Docker and Compose are intentionally disabled as SG rollout paths. The image
workflow proves an OCI artifact can build and boot by digest; it does not grant
that artifact production ownership.

## Fleet topology and runtime drift

The historical heartbeat design publishes logical node identity, process audit data,
region ownership, deployed SHA, deterministic worker release ID, and capture state.
Its evaluator was designed to require:

- one distinct owner for every required region (`local`, `vps_sg`);
- no duplicate region owner and no combined owner;
- well-formed fresh entries with capture enabled; and
- one valid `WORKER_RELEASE_ID` across the active fleet.

The release ID, not Git SHA alone, is the runtime drift identity. App-only
commits can have different SHAs while preserving identical worker bytes. SHA is
still retained as audit evidence.

Deployment-log readiness and fleet readiness were designed as different proofs.
The historical design compared a startup identity record with a separate Redis
evaluation; neither is current-state evidence and neither proves the other. V1 does
not authorize a deployment-marker lookup, a Redis check, or any cron evaluation.

## Known process-cardinality gap

The legacy roster is keyed by logical `WORKER_NODE_ID`. Two processes reusing
the same ID overwrite the same Redis field, so the roster cannot prove real
process cardinality even though the payload contains a PID. Authorized paths
reduce this risk by requiring one exact PM2 owner and disabling the Docker path,
but they do not close the data-model gap.

The complete fix requires a per-node Redis ownership lease plus an independent
per-boot instance record:

- a random owner token and monotonic lease epoch;
- atomic acquire, compare-renew, and compare-delete operations;
- fail-closed self-fencing before the lease can expire;
- no consumer, scheduler, failover, or heartbeat startup before ownership;
- fresh owner and contender instances grouped by logical node; and
- readiness failure on duplicate instances, contenders, or epoch mismatch.

Until that protocol is deployed to both nodes, do not claim that the heartbeat
roster alone rules out a manually started or malicious duplicate process. The route
is not an authorization to schedule, restart, or inspect a worker during V1.

## On-chain enrichment containment

`maint:onchain-enrich` was historically reconciled every 12 hours on the local BullMQ
queue. In the checked-in V1 source, the fixed ingest gate makes scheduler reconciliation
return before DB/BullMQ work, the native worker entry does not start, the direct script
does not run, and `POST /api/trader/onchain-enrich` is the fixed 410/no-store contract
above. This does not remove, stop, or prove any scheduler, crontab, worker, provider
spend, or write path outside this checkout.

## SG dependency incident boundary

The 2026-06-30 outage was caused by concurrent or interrupted package installs
mutating the same live dependency tree. Packages appeared installed while
runtime files were missing, and the worker crash-looped. The durable lessons are:

- never install into live `/opt/arena-ingest/node_modules`;
- never delete the only working live dependency tree;
- build changed dependencies on a healthy Node 22 Linux x64 runner;
- validate resolution and actual imports before cutover; and
- switch code and dependencies as one complete candidate directory.

Do not revive the historical recovery loop of repeated installs or manual package
extraction. V1 does not authorize any recovery workflow; a future owner-approved
plan must establish a new artifact and host boundary first.
