import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716063000_rebuild_leaderboard_count_cache.sql'),
  'utf8'
)

describe('leaderboard count cache rebuild migration', () => {
  it('serializes and clears the old generation before rebuilding every count family', () => {
    const lock = migration.indexOf('pg_advisory_xact_lock')
    const deletion = migration.indexOf('DELETE FROM public.leaderboard_count_cache')
    const firstInsert = migration.indexOf('INSERT INTO public.leaderboard_count_cache')

    expect(lock).toBeGreaterThan(-1)
    expect(deletion).toBeGreaterThan(lock)
    expect(firstInsert).toBeGreaterThan(deletion)
    expect(migration.match(/INSERT INTO public\.leaderboard_count_cache/g)).toHaveLength(4)
    expect(migration).toContain("source || '_gt0'")
    expect(migration).toContain("'_all_gt0'")
  })

  it('preserves the two serving predicates and primes the repaired cache', () => {
    expect(migration.match(/arena_score > 10/g)).toHaveLength(2)
    expect(migration.match(/arena_score > 0/g)).toHaveLength(2)
    expect(migration.match(/is_outlier IS NULL OR is_outlier = false/g)).toHaveLength(4)
    expect(migration).toContain('SELECT public.refresh_leaderboard_count_cache();')
    expect(migration).toContain('SET search_path = public, pg_temp')
  })
})
