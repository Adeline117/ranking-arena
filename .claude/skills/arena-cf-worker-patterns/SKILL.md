# Arena CF Worker Legacy Proxy Containment — V1 NO-GO

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

These are checked-in source contracts, not evidence that an external Worker, route,
proxy, host, queue, or schedule is deployed, stopped, or healthy.

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
Do not generalize this list into a claim that all source writers have been closed.
`app/api/cron/backfill-avatars`, avatar helpers, adapters, and unlisted import/write
paths are outside this skill's conclusion and need separate review.

## Safe review output

When a geo-block, proxy, or source-acquisition issue is reported, record only the
local source path, its fixed contract, test evidence, and the missing owner-approved
evidence needed for a future review. Do not provide a workaround, deployment sequence,
route-addition recipe, fallback order, or operational command.
