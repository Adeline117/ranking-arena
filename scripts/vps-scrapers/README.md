# Historical VPS Playwright Scraper Handlers — V1 NO-GO

This directory is retained as historical source/design context only. It is not a VPS
address book, deployment guide, handler-registration recipe, process-management guide,
or authorization to access a host.

## Checked-in containment

The legacy scraper/proxy source entrypoints `scripts/vps-deploy/scraper-v16-parallel.js`
and `scripts/vps-deploy/arena-proxy.mjs` report `RETIRED` and exit `2` before browser,
proxy, import, or host work. The related historical import and verification entrypoints
listed in `scripts/import/NEW_EXCHANGES_README.md` have the same source-only behavior.
The checked-in Cloudflare Worker separately returns fixed `410
LEGACY_PROXY_IMPORT_NOT_PUBLISHED` with three `no-store` headers and no upstream fetch.
The canonical `GET /api/cron/backfill-avatars` route and its
`/api/v1/cron/backfill-avatars` rewrite alias resolve to the same auth-first source-only
tombstone handler: missing or invalid service authentication returns `401`; valid
authentication returns `410 CRON_EXECUTION_NOT_PUBLISHED`. Both paths carry three
`no-store` headers and return before parameter parsing, database access, logging, or
upstream fetch.

Anonymous `GET /api/avatar` and its `/api/v1/avatar` rewrite alias are separately held
to the same fixed `410` source-only response with `Cache-Control`,
`CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` `no-store` headers before query
parsing, DNS lookup, upstream fetch, or logging. The matching proxy bypass only
preserves that anonymous response contract; it does not authorize an upstream proxy.
Registered helpers and known UI/OG consumers no longer generate a proxy request: a
proxy-required origin without a mirror uses local, inline, or default fallback.

The checked-in `avatar-mirror` worker execution is separately source-only retired: its
processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a legacy
queued avatar-mirror job returns as a no-op within `route()` before that handler calls
`getConnection()`, acquires its per-job source lease, or loads a processor. This makes
no claim that the surrounding worker or BullMQ has not already established or used
shared Redis, or acquired a job lock.

This does not stop, inspect, restart, or prove an already deployed VPS scraper/proxy,
Cloudflare Worker, host process, queue, external scheduler, or healthcheck. Do not
infer that every browser, adapter, helper, or source write is held. The avatar-mirror
hold itself cannot stop, inspect, restart, or prove an already-running worker, Redis,
host process, or schedule. The avatar-proxy hold cannot clear old CDN cache, stop older
deployed code, or prove external state; it does not mean all avatar browser/network
activity is zero, because existing Supabase mirrors and direct allowed raw-avatar URLs
may still render. Other avatar-related API paths/helpers, UI/read RPCs, adapters, and
unlisted writers are outside this containment review.

## Historical design surfaces

Older handlers modelled browser-observed copy-trading surfaces for KuCoin, WEEX,
Kwenta, BitMart, and BTSE. Their presence records an old parser/normalization design;
it does not show that a browser endpoint exists, that a source is healthy, or that a
worker may be started. A future owner-approved plan must define the exact source,
evidence, runtime owner, publication boundary, and rollback plan before any operational
procedure can be published.
