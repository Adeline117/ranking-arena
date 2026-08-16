# Diagnose an Arena data pipeline issue

Diagnosis does not authorize a live write, backfill, cron invocation, worker restart,
proxy change, migration, deploy, or secret access.

## 1. Capture current evidence

```bash
npm run check:status
npm run check:freshness
npm run check:platforms
```

Treat each output as a probe, not truth. Record commit, environment, observation
time, release identity, and any unavailable dependency. These commands diagnose;
they do not authorize a generated remediation or automatic fix mode.

## 2. Identify the current authority path

- Vercel schedules: vercel.json and the exact app/api/cron route.
- External ingest: worker/src/ingest-worker.ts, the worker registry, and
  lib/ingest/adapters/register.ts.
- Source implementation: lib/ingest/adapters/<source>/.
- Ranking freshness: arena_freshness_expected_sources(),
  arena_visible_sources(), and leaderboard_source_freshness.source_as_of.
- Serving output: publication/eligibility-gated leaderboard_ranks.

Do not use removed per-source fetch routes, legacy lib/cron/fetchers paths, or the
retired traders/trader_snapshots relations.

## 3. Reproduce safely

1. Locate the adapter and tests with rg.
2. Reproduce parsing against an existing redacted fixture or add a deterministic one.
3. Check identity, window, units, pagination, timestamps, and null behavior.
4. Verify errors reach the worker/job result instead of being recorded as success.
5. If live network/database evidence is missing, report that witness as missing.

Never curl a production cron route, run a manual backfill, invoke exec_sql, or use
trader_daily_snapshots to fill metrics.

## 4. Implement and verify

Make the smallest code/test change. Preserve null when evidence is absent; bound
remote work and retries. Run focused adapter/job tests, both typechecks, lint,
relevant publication QA, and a no-write dry run.

Infrastructure, scheduling, database apply, deployment, and production verification
remain separate reviewed steps.
