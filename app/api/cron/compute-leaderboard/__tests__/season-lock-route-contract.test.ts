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

  it('fails closed when the database season lock is denied or errors', () => {
    expect(route).toContain('if (lockError)')
    expect(route).toContain('if (lockResult !== true)')
    expect(route).toContain('database season lock unavailable; refusing concurrent writes')
    expect(route).not.toContain('Proceeding anyway')

    const acquireIndex = route.indexOf("supabase.rpc('acquire_leaderboard_lock'")
    const upsertIndex = route.indexOf('await upsertLeaderboard({')
    expect(acquireIndex).toBeGreaterThan(-1)
    expect(upsertIndex).toBeGreaterThan(acquireIndex)
  })
})
