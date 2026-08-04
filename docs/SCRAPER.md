# Source Acquisition and Scraper Operations

Status: **Canonical transport guide**

Public ranking acquisition is owned by the external BullMQ ingest worker.
`arena.sources` selects active sources, cadence, and `fetch_region`; adapters
under `lib/ingest/adapters/` implement source-specific acquisition and pure
parsing. There is no Vercel exchange-fetch loop or standalone connector registry.

## Transport model

An adapter may use direct HTTP, a region-affine worker, or a bounded browser
transport. Every path must use the shared fetch budget, persist durable RAW
evidence before parsing, and preserve the acquisition attempt/provenance chain.
Geo routing is an adapter and registry concern, not a fallback that silently
returns an empty leaderboard.

```text
arena.sources
    -> regional BullMQ queue
    -> registered source adapter
    -> bounded network/browser acquisition
    -> durable RAW artifact
    -> pure parser + validation
    -> complete-board publication
```

## Adding or changing a source

Follow `docs/ADAPTER_ONBOARDING.md`. In particular:

- capture real upstream evidence and document available metrics;
- keep parsers independent of network, clock, and module state;
- add representative RAW fixtures and expected-metric parity tests;
- register the adapter and add the source row through a forward migration;
- validate the correct fetch region and worker capacity before activation.

Do not add a route to `vercel.json`, write directly to serving tables, edit an
applied migration, or restore a retired connector/fetcher.

## Diagnosis

1. Check source status, serving mode, adapter slug, and fetch region.
2. Check worker heartbeat/ownership and the source region queue.
3. Inspect the latest acquisition attempt and durable RAW artifact.
4. Separate transport, schema, parser, validation, and publication failures.
5. Reproduce parsing from stored RAW before making another upstream request.
6. Verify source freshness and public visibility after the next successful
   publication.

Useful references:

- `docs/INGEST_WORKER_TOPOLOGY.md`
- `docs/INGEST_WORKER_DEPLOY.md`
- `docs/RUNBOOK.md`
- `lib/ingest/fetch/`
- `lib/ingest/adapters/`
- `worker/src/ingest/`

Worker restarts, source activation, production queue mutation, and backfills are
state-changing operations and require a bounded rollout and rollback plan.
