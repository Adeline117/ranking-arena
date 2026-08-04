# Skill: Data Quality Audit

Use this workflow for stale, missing, or semantically incorrect ranking data.
The active `arena.sources` registry and the BullMQ ingest worker are the only
first-party acquisition authority. Do not add per-exchange Vercel crons or
restore connector/scraper roots.

## Quick checks

```bash
npm run check:status
npm run check:freshness
npm run check:platforms
node scripts/pipeline-health-check.mjs --quick
# Requires read-only production credentials and refreshes the coverage ledger:
npm run qa:coverage
```

For production inspection, prefer the authenticated monitoring surfaces:

- `/api/admin/data-freshness` for serving freshness and source watermarks.
- `/api/admin/monitoring/arena-pipeline` for registry, attempt, validation, and
  publication evidence.
- `/api/health/pipeline` for external pipeline health.

## Audit sequence

1. Confirm the source is active in `arena.sources` and note its execution region,
   cadence, serving mode, and adapter metadata.
2. Inspect the latest `arena.fetch_attempts` and RAW evidence. A missing attempt,
   rejected capture, incomplete board, and failed publication are different
   failure classes and must not be conflated.
3. Reproduce the parser with a sanitized RAW fixture under
   `lib/ingest/adapters/<source>/__tests__/`; never debug by writing production
   rows or logging credentials/cookies.
4. Compare declared metrics in `lib/ingest/adapters/expected-metrics.ts` with
   captured fields, normalized values, and published score inputs.
5. Fix the narrowest adapter, transport, validation, or publication boundary.
   Preserve RAW-before-parse and fail-closed board-completeness gates.
6. Run the adapter tests, ingest-worker type/lint checks, architecture QA, and a
   read-only monitoring query after deployment.

## Required evidence

- Source slug and authoritative region.
- Attempt id/time and terminal status.
- Sanitized fixture plus failing-then-passing parser test.
- Before/after metric coverage or freshness watermark.
- Confirmation that no timestamp or score was manually fabricated.

## Guardrails

- Applied migrations are immutable.
- `source_as_of` comes from upstream evidence, never `now()` or `computed_at`.
- Do not revive `connectors/`, `lib/cron/fetchers/`, `refresh_jobs`, or retired
  per-platform cron routes.
- A source is not healthy merely because a scheduler or HTTP request returned 2xx.
