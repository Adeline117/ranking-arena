# Arena Supabase Operations

Operate conservatively. This guide describes repository-side inspection and migration
preparation; it does not authorize a production connection or mutation.

## Sources of truth

1. lib/supabase/database.types.ts for the generated public client surface
2. supabase/migrations for versioned public and private arena schema intent
3. current application queries for real access patterns
4. an approved read-only live catalog capture for deployed state

Generated types and migration files can drift from production. Record the commit,
project, timestamp, and query before drawing a live conclusion.

## Current ranking relations

### trader_sources

- Primary key: id; unique lookup key: source plus source_trader_id
- Legacy public serving/enrichment identity projection; private arena.traders is
  the canonical ingest identity layer
- last_seen_at and last_refreshed_at are activity inventory, not publication freshness
- Profile fields include handle, avatar_url, source_kind, and source_type

### leaderboard_ranks

- Unique identity key: season_id, source, source_trader_id
- Fields include rank, arena_score_v4, computed_at, metrics_estimated,
  score_completeness, and is_outlier
- Consumers must also enforce the repository publication/eligibility policy
- computed_at is row compute time; it does not replace
  leaderboard_source_freshness.source_as_of or a sealed cohort proof

### trader_daily_snapshots

- Primary key: id; unique legacy key: platform, trader_key, and date
- No season, generation, cohort, or publication proof
- Producer, cleanup, scanner, and public derived consumers remain quarantined
- Never use it to fill ranking metrics or restore a historical product response

The old traders and trader_snapshots names are not present in current generated
types and must not be used in new SQL or client code.

Private arena relations are intentionally absent from the generated public client
surface. Verify them against versioned migrations and the worker database boundary,
not by assuming their absence from database.types.ts.

## Safe read-only checks

```sql
SELECT source, season_id, COUNT(*) AS rows, MAX(computed_at) AS latest
FROM leaderboard_ranks
GROUP BY source, season_id
ORDER BY source, season_id;

SELECT source, COUNT(*) AS identities, MAX(last_seen_at) AS latest_seen
FROM trader_sources
GROUP BY source
ORDER BY source;
```

Validate relation and column existence before running even these queries.

## Migration workflow

1. Add a forward-only migration; never edit applied history.
2. Add static contract coverage and an isolated PG17 behavior test when PostgreSQL
   semantics matter.
3. Run migration-history shape tests and replay/idempotency checks.
4. Review grants, RLS, SECURITY DEFINER routines, triggers, cron jobs, and rollback behavior.
5. Treat the SQL as a candidate until an approved runner verifies the exact live
   migration ledger and drift.

Do not use CASCADE without an explicit dependency inventory. Do not use dynamic
general-purpose SQL RPCs. exec_sql and legacy daily cleanup/read RPCs are retired by
the daily-snapshot quarantine candidate.

## Prohibited without explicit authorization

- Reading or printing credentials
- Connecting to or mutating production
- Applying migrations
- Running DML/DDL, cleanup, backfill, or repair RPCs
- Changing grants, RLS, schedules, workers, or deployment state
- Restoring any legacy daily snapshot writer or consumer
