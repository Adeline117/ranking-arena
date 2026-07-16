import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260716070000_snapshot_consistent_leaderboard_counts.sql'
  ),
  'utf8'
)

describe('snapshot-consistent leaderboard count cache migration', () => {
  it('computes all four count families in one statement snapshot', () => {
    expect(migration.match(/INSERT INTO public\.leaderboard_count_cache/g)).toHaveLength(1)
    expect(migration.match(/UNION ALL/g)).toHaveLength(3)
    expect(migration.match(/FROM public\.leaderboard_ranks/g)).toHaveLength(4)
    expect(migration.match(/arena_score > 10/g)).toHaveLength(2)
    expect(migration.match(/arena_score > 0/g)).toHaveLength(2)
  })

  it('retains serialized replacement and primes the cache', () => {
    const lock = migration.indexOf(
      'LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE'
    )
    const deletion = migration.indexOf('DELETE FROM public.leaderboard_count_cache')
    const insertion = migration.indexOf('INSERT INTO public.leaderboard_count_cache')

    expect(lock).toBeGreaterThan(-1)
    expect(deletion).toBeGreaterThan(lock)
    expect(insertion).toBeGreaterThan(deletion)
    expect(migration).toContain('SELECT public.refresh_leaderboard_count_cache();')
  })
})
