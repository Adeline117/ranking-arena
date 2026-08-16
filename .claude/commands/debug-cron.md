# Debug a scheduled job

Diagnose first; do not trigger production, change a schedule, read secrets, or deploy
unless that action is separately authorized.

## Establish the real job

1. Confirm the exact path and cadence in vercel.json.
2. Confirm the handler exists under app/api/cron/\*\*/route.ts.
3. Check whether it is an active job, an unscheduled endpoint, or an auth-first
   retired tombstone.
4. Record the commit, environment, and observation time.

An endpoint name in an old note is not schedule evidence.

## Read-only diagnosis

- Inspect the route's authentication, timeout, lock, and PipelineLogger boundary.
- Inspect current tests and recent history for the exact route.
- When access is approved, read Vercel/Sentry/pipeline logs without printing tokens
  or private payloads.
- For worker adapters, inspect lib/ingest/adapters and
  lib/ingest/fetch/rate-limiter.ts; external ingest cadence may come from the worker
  registry rather than Vercel.
- For database errors, use an approved read-only catalog/log surface. Do not query a
  guessed postgres_logs relation.

## Common findings

- Timeout: bound work per invocation, paginate, and move long work to the existing
  worker path through a reviewed design.
- Authentication: test the verifier with inert local values; never print or rotate
  CRON_SECRET during diagnosis.
- Rate limiting: classify 429/timeout/5xx, cap retry/backoff, and bound concurrency.
- Geo restriction: report the missing network witness; proxy/VPS changes are a
  separate infrastructure action.
- False success: ensure data/RPC/alert errors reach the job result and tests.

## Verification

Use focused unit tests with mocked dependencies. If a local route invocation is
needed, use an inert local environment and a non-production database fixture. Run
typecheck, lint, schedule-contract QA, and the relevant job tests.

Never use curl against a production cron route as a diagnostic shortcut.
