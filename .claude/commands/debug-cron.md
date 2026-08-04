# Debug Scheduled Work

First identify the owner. Vercel schedules are declared in `vercel.json`;
first-party exchange ingestion is owned by the external BullMQ worker and the
`arena.sources` registry.

## Vercel cron

1. Confirm the route is actually present in `vercel.json`.
2. Inspect Vercel function logs and `pipeline_logs` for the exact route name.
3. Check auth through the shared cron wrapper and confirm `CRON_SECRET` exists
   without printing its value.
4. Check route budget, lock acquisition, and downstream timeout separately.
5. Use a local or preview trigger first. A production trigger is a state-changing
   operation and requires explicit approval.

Key paths: `vercel.json`, `app/api/cron/`, `lib/cron/`,
`lib/services/pipeline-logger.ts`, and `docs/RUNBOOK.md`.

## Ingest worker

1. Check `/api/cron/worker-heartbeat-check` and the worker release-readiness probe.
2. Inspect BullMQ queue/scheduler state for the source region.
3. Confirm the source row is active, has the expected `fetch_region`, and has a
   registered adapter in `lib/ingest/adapters/register.ts`.
4. Inspect durable acquisition attempts, RAW evidence, validation outcome, and
   publication receipt before changing retries or cadence.
5. Follow `docs/INGEST_WORKER_DEPLOY.md` for restart, rollout, and rollback.

Do not repair ingest freshness by adding a legacy connector, writing directly to
serving tables, manually changing `source_as_of`, or silently returning empty data.
