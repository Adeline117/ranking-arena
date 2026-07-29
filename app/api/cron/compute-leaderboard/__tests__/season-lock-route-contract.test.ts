import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')
const lock = readFileSync(join(__dirname, '..', 'season-lock.ts'), 'utf8')

describe('compute-leaderboard route lock contract', () => {
  it('routes full and single-season runs through the shared season-lock helper', () => {
    expect(route).toContain('acquireLeaderboardSeasonLocks(')
    expect(route).not.toContain('cron:compute-leaderboard:running${lockSuffix}')
    expect(route).not.toContain('tieredDel(')
    expect(route).not.toMatch(/\.del\(IDEMPOTENCY_KEY\)/)
    expect(lock).toContain("['7D', '30D', '90D']")
    expect(lock).toContain('randomUUID()')
    expect(lock).toContain("redis.call('GET', KEYS[1]) == ARGV[1]")
  })

  it('never uses session-level PostgreSQL advisory locks through pooled RPC calls', () => {
    expect(route).not.toContain("supabase.rpc('acquire_leaderboard_lock'")
    expect(route).not.toContain("supabase.rpc('release_leaderboard_lock'")
    expect(route).not.toContain('pg_try_advisory_lock')
    expect(route).not.toContain('pg_advisory_unlock')
    expect(route).toContain(
      'PostgREST may execute acquire and release on different pooled connections'
    )
  })

  it('keeps the Redis lease longer than the route hard runtime limit', () => {
    const maxDuration = Number(route.match(/export const maxDuration = (\d+)/)?.[1])
    const ttlSeconds = Number(lock.match(/LEADERBOARD_SEASON_LOCK_TTL_SECONDS = (\d+)/)?.[1])

    expect(maxDuration).toBeGreaterThan(0)
    expect(ttlSeconds).toBeGreaterThan(maxDuration)
  })
})
