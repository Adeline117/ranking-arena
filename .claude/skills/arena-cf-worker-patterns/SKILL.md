# Arena CF Worker, Avatar-Backfill, and Avatar-Mirror Containment — V1 NO-GO

This skill is a report-only source-review aid during V1. It does not authorize a
Cloudflare deployment, dashboard/API access, credential use, route invocation, proxy
configuration, upstream fetch, or host/VPS action.

## Checked-in source contract

`cloudflare-worker/src/index.ts` is a historical proxy implementation held to a fixed
response: every request returns `410 LEGACY_PROXY_IMPORT_NOT_PUBLISHED` with all three
no-store headers (`Cache-Control`, `CDN-Cache-Control`, and
`Vercel-CDN-Cache-Control`) and does not make an upstream fetch.

`GET /api/proxy/phemex` is a separate Edge-route hold. It authenticates before
disclosing the hold: missing or invalid service authentication returns `401`; valid
authentication returns `410 LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED`. Both paths carry
the same three no-store headers and finish before URL/query parsing, logging, or an
upstream request.

The canonical `GET /api/cron/backfill-avatars` route and its
`/api/v1/cron/backfill-avatars` rewrite alias resolve to the same source-only tombstone
handler. It authenticates first: missing or invalid service authentication returns
`401`; valid authentication returns `410 CRON_EXECUTION_NOT_PUBLISHED`. Both paths
carry the same three `no-store` headers and return before parameter parsing, database
access, logging, or upstream fetch. It is not a cron-invocation or backfill procedure.

Treat the checked-in `avatar-mirror` worker execution as separately source-only retired:
its processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a
legacy queued avatar-mirror job returns as a no-op within `route()` before that handler
calls `getConnection()`, acquires its per-job source lease, or loads a processor. Do
not infer that the surrounding worker or BullMQ has not already established or used
shared Redis, or acquired a job lock. Do not treat this as a worker-operation procedure.

These are checked-in source contracts, not evidence that an external Worker, route,
proxy, host, queue, Redis, external scheduler, or healthcheck is deployed, stopped, or
healthy. In particular, the avatar-mirror hold cannot stop, inspect, or prove an
already-running worker, Redis, host process, or schedule.

## Scope boundary

The corresponding legacy acquisition containment is restricted to the named CF/edge
entries plus these historical script entrypoints:

- `scripts/import/import_all_platforms.mjs`
- `scripts/import/refresh.sh`
- `scripts/import/import-all-blocked.sh`
- `scripts/import/run_hl_enrichment.sh`
- `scripts/vps-deploy/scraper-v16-parallel.js`
- `scripts/vps-deploy/arena-proxy.mjs`
- `scripts/archive/test-vps-scrapers.ts`
- `scripts/archive/verify-data-accuracy.mjs`

The scripts report `RETIRED` and exit `2` before proxy, browser, import, or host work.
Do not generalize this list into a claim that all source writers have been closed. The
separate avatar-backfill tombstone covers only its canonical/rewrite-alias handler, and
the separately retired avatar-mirror worker covers only its processor, scheduler, and
legacy queued-job behavior. `/api/avatar`, avatar helpers, UI/read RPCs, adapters, and
unlisted writers remain outside this skill's conclusion and need separate review.

## Safe review output

When a geo-block, proxy, or source-acquisition issue is reported, record only the
local source path, its fixed contract, test evidence, and the missing owner-approved
evidence needed for a future review. Do not provide a workaround, deployment sequence,
route-addition recipe, fallback order, or operational command.
