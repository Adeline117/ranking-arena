# Fix Ingest Pipeline

Use the authoritative worker path. Do not add a Vercel exchange fetcher or
legacy connector as a fallback.

## Diagnose

1. Read `docs/RUNBOOK.md`, `docs/ARCHITECTURE.md`, and
   `docs/INGEST_WORKER_DEPLOY.md`.
2. Confirm the affected source is active/serving in `arena.sources` and its
   adapter is registered under `lib/ingest/adapters/`.
3. Trace one observation through scheduler, queue, acquisition attempt, durable
   RAW artifact, parser/validation outcome, publication receipt, and serving
   freshness.
4. Distinguish transport failure, schema drift, parser drift, incomplete-board
   rejection, worker ownership/lease failure, and serving projection failure.
5. Preserve fail-closed behavior: never invent metrics, publish partial boards,
   or advance freshness clocks manually.

## Verify a fix

```bash
npm run qa:architecture
npm run qa:schema
npm run type-check
npm test -- --runInBand lib/ingest worker/src/ingest
npm run build
```

Run the relevant parser fixture, parity, worker contract, and publication tests
in addition to the broad checks. Production backfills, queue mutations, source
activation, and worker restarts require an explicit bounded rollout and rollback
plan.

## Key paths

- `lib/ingest/adapters/` — source acquisition and pure parsers
- `lib/ingest/staging/` — validation and evidence staging
- `lib/ingest/serving/` — complete-board publication
- `worker/src/ingest/` — scheduling, ownership, queues, and processors
- `app/api/cron/check-data-freshness/` — serving freshness sentinel
- `docs/postmortems/` — prior incident evidence
