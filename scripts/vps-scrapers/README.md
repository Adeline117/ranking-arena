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

This does not stop, inspect, restart, or prove an already deployed VPS scraper/proxy,
Cloudflare Worker, host process, queue, or schedule. Do not infer that every browser,
adapter, helper, or source write is held: `app/api/cron/backfill-avatars`, avatar
helpers, adapters, and any unlisted path are outside this containment review.

## Historical design surfaces

Older handlers modelled browser-observed copy-trading surfaces for KuCoin, WEEX,
Kwenta, BitMart, and BTSE. Their presence records an old parser/normalization design;
it does not show that a browser endpoint exists, that a source is healthy, or that a
worker may be started. A future owner-approved plan must define the exact source,
evidence, runtime owner, publication boundary, and rollback plan before any operational
procedure can be published.
