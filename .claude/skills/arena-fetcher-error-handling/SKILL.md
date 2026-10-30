---
name: arena-fetcher-error-handling
description: Review or implement bounded failure handling for current Arena worker SourceAdapters without fabricating metrics or publishing partial cohorts.
---

# Arena Adapter Error Handling

Apply this guidance to the current worker adapters under `lib/ingest/adapters/`.
First confirm the adapter is registered by `lib/ingest/adapters/register.ts` and
loaded by `worker/src/ingest-worker.ts`.

## Required behavior

- Bound every remote call with an explicit timeout.
- Retry only classified transient failures such as timeout, 429, and selected 5xx.
- Use capped exponential backoff with jitter and a finite attempt count.
- Bound concurrency; never use unbounded `Promise.all` for exchange requests.
- Preserve identity, season/window, source observation time, and upstream evidence.
- Treat malformed or semantically ambiguous payloads as unavailable; never fabricate
  win rate, drawdown, Sharpe, Sortino, or another metric.
- Log structured, redacted context. Never log credentials, private account payloads,
  secret-bearing URLs, or full upstream bodies.
- Propagate a typed failure so the worker and publication gate cannot record a
  partial/failed batch as success.

## Persistence boundary

The worker writes private `arena` schema relations through the current ingest
database boundary. Public generated Supabase types do not describe private `arena`
relations. Do not copy an old PostgREST upsert template or write the removed
`trader_snapshots` relation.

Before changing persistence:

1. inspect the current adapter and worker writer;
2. verify private relation/constraint truth in versioned migrations;
3. add a deterministic fixture and failure-path test;
4. prove no partial publication occurs when any required write fails.

Never use `exec_sql`, a general cleanup RPC, or `trader_daily_snapshots` as a fallback.

## Proxy and fallback

A proxy is a separately operated dependency, not an automatic retry. Use one only
when its route, authentication, privacy boundary, and deployment are already
versioned and approved. Do not deploy or reconfigure Cloudflare/VPS infrastructure
from an adapter fix without explicit authority.

## Verification

Run the adapter parser/fetch tests, worker typecheck and lint, relevant ingest
integration tests, publication/authority tests, and a dry run that performs no
external write. Report unavailable live witnesses explicitly.
