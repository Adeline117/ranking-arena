-- Migration: 20260615125511_arena_serving_sources_rpc.sql
-- Created: 2026-06-15T19:55:11Z
-- Description: arena_serving_sources() — single source of truth for the
--   frontend read-path cutover flag (serving_mode), replacing the hand-edited
--   Redis list + stale env that drifted.

-- arena_serving_sources() — the single source of truth for the frontend
-- read-path cutover flag (ARENA_DATA_SPEC §2.4 serving_mode state machine).
--
-- Why this exists: the frontend `getDataMode(platform)` decides legacy vs
-- serving per source. That decision was duplicated into a hand-edited Redis
-- list + a stale env var, which DRIFTED (the env was empty; Redis was missing
-- 4 legacy aliases — xt/blofin/btcc/bitunix — so traders resolving via those
-- legacy names rendered the empty legacy page). This RPC makes arena.sources
-- the ONE authoritative source: a source is "serving" iff serving_mode='serving',
-- and the frontend resolves traders by BOTH the arena slug AND the legacy
-- platform alias (meta->>'legacy_platform'), so the set must expose both.
--
-- Consumed by:
--   - lib/constants/serving-cutover.ts  (self-heal fallback when Redis absent)
--   - worker/src/ingest/scheduler.ts    (reconciles the Redis mirror each cycle)
-- so flipping serving_mode in the DB is the ONLY control surface — no manual
-- Redis/env editing, no drift.

-- Up
CREATE OR REPLACE FUNCTION public.arena_serving_sources()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, arena
AS $$
  SELECT coalesce(array_agg(DISTINCT name), ARRAY[]::text[])
  FROM (
    SELECT slug AS name FROM arena.sources WHERE serving_mode = 'serving'
    UNION
    SELECT meta->>'legacy_platform'
    FROM arena.sources
    WHERE serving_mode = 'serving' AND coalesce(meta->>'legacy_platform', '') <> ''
  ) s
$$;

GRANT EXECUTE ON FUNCTION public.arena_serving_sources() TO anon, authenticated, service_role;
