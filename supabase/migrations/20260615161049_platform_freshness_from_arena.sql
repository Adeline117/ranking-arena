-- Migration: 20260615161049_platform_freshness_from_arena.sql
-- Created: 2026-06-15T23:10:49Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Up
-- Migrate get_platform_freshness() off retiring public.trader_latest to arena.
-- The health check wants FETCH freshness (when a source was last crawled), not
-- score freshness — arena.leaderboard_snapshots.scraped_at is exactly that, and
-- survives the trader_latest drop. Keyed by the legacy platform alias
-- (meta.legacy_platform → slug) so existing health/alert platform names match.
CREATE OR REPLACE FUNCTION public.get_platform_freshness()
RETURNS TABLE(source text, latest timestamptz)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'arena'
AS $$
  SELECT COALESCE(s.meta->>'legacy_platform', s.slug) AS source,
         max(ls.scraped_at) AS latest
  FROM arena.leaderboard_snapshots ls
  JOIN arena.sources s ON s.id = ls.source_id
  GROUP BY COALESCE(s.meta->>'legacy_platform', s.slug);
$$;
