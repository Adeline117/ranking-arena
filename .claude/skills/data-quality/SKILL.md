# Data Quality Audit

Use this workflow for a read-only Arena data-quality review. Repository state can
describe intended behavior; live state must be captured separately through approved
read-only access.

## Start with existing checks

```bash
npm run check:status
npm run check:freshness
npm run check:platforms
```

Record command time, commit SHA, environment, and failures. Do not turn a failed
probe into a write or schedule change.

The check:enrichment script is excluded until its retired-relation and stale-column
queries are replaced; its current success status is not usable audit evidence.

## Authority map

- leaderboard_ranks contains current per-season ranking rows. Serving code and
  publication/eligibility contracts decide which rows are public.
- private arena.traders is the canonical ingest identity layer. Public
  trader_sources is a legacy serving/enrichment identity projection; its activity
  timestamps are inventory, not publication freshness.
- trader_daily_snapshots is frozen legacy forensic inventory. It is not ranking,
  equity, indicator, recommendation, Movers, or V3-history authority.
- Historical table names from old reports, including traders and trader_snapshots,
  are not current schema contracts.

## Audit procedure

1. Verify every table and column against lib/supabase/database.types.ts.
2. Review source/season counts and MAX(computed_at) in leaderboard_ranks.
3. Review last_seen_at and last_refreshed_at in trader_sources only as identity
   activity inventory. Use arena_freshness_expected_sources(),
   arena_visible_sources(), and leaderboard_source_freshness.source_as_of for the
   ranking freshness contract.
4. Measure null coverage on current ranking columns without inventing a target fill
   rate for evidence that a source cannot provide.
5. Sample only the columns necessary to confirm an anomaly; do not export private data.
6. Record trader_daily_snapshots only by date/platform/count as untrusted inventory.
7. Separate confirmed live results from inferences based on repository code.

Use the canonical read-only SQL in .claude/agents/data-auditor.md. If the live
catalog disagrees with generated types or migrations, stop and report schema drift.

## Remediation boundary

- Do not run backfills, cleanup RPCs, exec_sql, DML, DDL, migrations, or retired cron routes.
- Do not calculate missing Sharpe, Sortino, win rate, or drawdown from unrelated
  periods or unproven daily rows.
- A connector code fix must identify the current implementation with rg, include a
  dry-run or fixture test, and preserve null when the upstream evidence is absent.
- Applying a migration, changing a schedule, or touching production requires a
  separate reviewed plan and explicit authority.

## Report checklist

- Commit and observation time recorded
- Source and season named
- Read-only evidence attached
- Publication-authority limitation stated
- No secret or private row data included
- Next action is code/test/review work, not an unapproved live mutation
