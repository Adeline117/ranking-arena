# Fix GitHub Issue

Use a reproducible, reviewable change. Reading an issue does not authorize a
production mutation, deploy, merge, migration apply, or push to main.

## 1. Establish current truth

1. Read the full issue, expected behavior, affected identity/window, and observation time.
2. Inspect the current call chain and recent history with rg and git log.
3. Verify referenced routes, files, tables, and columns exist in this commit.
4. Separate repository evidence from live evidence. Use only approved read-only
   access for live diagnosis and never print secrets or private rows.

For ranking/source issues, use current relations and authority:

- private arena.traders and arena.trader_stats are the ingest layer;
- public leaderboard_ranks is the per-season serving projection;
- public leaderboard_source_freshness.source_as_of is the source watermark;
- public trader_sources is a legacy identity projection, not publication freshness;
- trader_daily_snapshots is quarantined forensic inventory and cannot supply metrics.

Do not query the removed traders or trader_snapshots relations.

## 2. Reproduce

- Prefer an existing focused test or deterministic fixture.
- For UI behavior, reproduce locally and capture the exact request/identity state.
- For source data, locate the current adapter under lib/ingest/adapters with rg;
  never guess worker/src/scrapers paths or run a guessed script.
- If live state is required but unavailable, report the missing witness instead of
  inventing a root cause.

## 3. Write the failing contract

Add the smallest test that proves the bug and would catch a regression. Include
identity, season/window, time bounds, null behavior, and authorization/cache
boundaries when relevant.

## 4. Implement narrowly

- Change only the confirmed path.
- Preserve null when evidence is absent.
- Do not add an ad hoc backfill, exec_sql call, unversioned RPC, or schedule.
- Adapter changes need redacted/synthetic fixtures, bounded retries/concurrency,
  and a dry-run/no-write verification path.

## 5. Verify

Run focused tests first, then the checks proportional to risk:

```bash
npm run type-check
npm run type-check:ingest-worker
npm run lint
npm test -- --runInBand
npm run build
```

Database semantics also require the relevant isolated PG17 proof. Never point a
test at an application or production database.

## 6. Hand off

Commit on the issue branch with evidence in the message or PR. Push/create a draft
PR only when that external write is in scope. Do not merge, deploy, apply migrations,
or alter production without separate explicit authority.
