import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729220908_season_scoped_leaderboard_count_cache.sql'),
  'utf8'
)
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/season-scoped-leaderboard-count-cache.pg17.sh'),
  'utf8'
)

describe('season-scoped leaderboard count-cache refresh', () => {
  it('installs one transactional, service-only SECURITY DEFINER function', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toMatch(
      /CREATE FUNCTION public\.refresh_leaderboard_count_cache_for_seasons\(\s*p_season_ids text\[\]\s*\)[\s\S]*?VOLATILE[\s\S]*?PARALLEL UNSAFE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp[\s\S]*?SET statement_timeout = '10s'/
    )
    expect(migration).toContain('DO $close_acl$')
    expect(migration).toContain('CROSS JOIN LATERAL pg_catalog.aclexplode(')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.refresh_leaderboard_count_cache_for_seasons\(text\[\]\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.refresh_leaderboard_count_cache_for_seasons\(text\[\]\)\s+TO service_role;/
    )
  })

  it('rejects empty, NULL, non-canonical, and duplicate season requests', () => {
    for (const marker of [
      'p_season_ids IS NULL',
      'pg_catalog.cardinality(p_season_ids) = 0',
      'requested.season_id IS NULL',
      "ARRAY['7D', '30D', '90D']::text[]",
      'pg_catalog.count(DISTINCT requested.season_id)::integer',
      "USING ERRCODE = '22023'",
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration.match(/USING ERRCODE = '22023'/g)).toHaveLength(4)
  })

  it('serializes with the full refresh and touches only requested seasons', () => {
    const compatibilityCheck = migration.indexOf(
      "'LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE'"
    )
    const lock = migration.indexOf(
      'LOCK TABLE public.leaderboard_count_cache\n    IN SHARE ROW EXCLUSIVE MODE'
    )
    const deletion = migration.indexOf('DELETE FROM public.leaderboard_count_cache AS cache')
    const insertion = migration.indexOf('INSERT INTO public.leaderboard_count_cache (')

    expect(compatibilityCheck).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(compatibilityCheck)
    expect(deletion).toBeGreaterThan(lock)
    expect(insertion).toBeGreaterThan(deletion)
    expect(migration).toContain('WHERE cache.season_id = ANY (v_target_season_ids);')
    expect(migration.match(/INSERT INTO public\.leaderboard_count_cache/g)).toHaveLength(1)
    expect(migration.match(/FROM public\.leaderboard_ranks AS rank_row/g)).toHaveLength(4)
    expect(migration.match(/rank_row\.season_id = ANY \(v_target_season_ids\)/g)).toHaveLength(4)
    expect(migration.match(/UNION ALL/g)).toHaveLength(3)
  })

  it('rebuilds the legacy and serving count families from one snapshot', () => {
    expect(migration.match(/rank_row\.arena_score > 10/g)).toHaveLength(2)
    expect(migration.match(/rank_row\.arena_score > 0/g)).toHaveLength(2)
    expect(migration.match(/rank_row\.is_outlier IS NULL/g)).toHaveLength(4)
    expect(migration).toContain("'_all'")
    expect(migration).toContain("'_all_gt0'")
    expect(migration).toContain("rank_row.source || '_gt0'")
    expect(migration.match(/pg_catalog\.statement_timestamp\(\)/g)).toHaveLength(4)
  })

  it('updates generated Supabase database types', () => {
    expect(databaseTypes).toContain('refresh_leaderboard_count_cache_for_seasons: {')
    expect(databaseTypes).toContain('Args: { p_season_ids: string[] }')
  })

  it('ships a PostgreSQL 17 behavior proof', () => {
    for (const marker of [
      'non-target cache rows changed during scoped refresh',
      'scoped refresh did not rebuild the exact four count families',
      'service_role could not execute the scoped refresh',
      'invalid season input was accepted',
      'scoped refresh did not serialize on the legacy full-refresh lock',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
