import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public ranking cache epoch boundary', () => {
  it.each([
    'app/api/rankings/live/route.ts',
    'app/api/cron/precompute-composite/route.ts',
    'app/api/rankings/platform-stats/route.ts',
    'app/api/sidebar/top-traders/route.ts',
    'app/api/trader/[platform]/[trader_key]/route.ts',
    'app/api/traders/[handle]/badges/route.ts',
    'app/api/traders/[handle]/full/route.ts',
    'app/api/traders/[handle]/route.ts',
    'lib/data/trader/similar.ts',
    'lib/realtime/ranking-store.ts',
  ])('%s cannot read a pre-authority ranking cache key', (path) => {
    expect(source(path)).toContain('publicRankingCacheKey')
  })

  it('epochs both the live sorted set and its detail hash', () => {
    const store = source('lib/realtime/ranking-store.ts')
    expect(store).toContain('publicRankingCacheKey(`${REDIS_KEY_PREFIX}:${period.toUpperCase()}`)')
    expect(store).toContain(
      'publicRankingCacheKey(`${DETAIL_HASH_PREFIX}:${period.toUpperCase()}`)'
    )
    expect(store).not.toMatch(/return `\$\{REDIS_KEY_PREFIX\}:\$\{period\.toUpperCase\(\)\}`/)
    expect(store).not.toMatch(/return `\$\{DETAIL_HASH_PREFIX\}:\$\{period\.toUpperCase\(\)\}`/)
  })

  it.each([
    'lib/realtime/ranking-store.ts',
    'app/api/rankings/live/route.ts',
    'app/api/rankings/platform-stats/route.ts',
    'app/api/sidebar/top-traders/route.ts',
    'app/api/traders/[handle]/badges/route.ts',
    'lib/data/trader/similar.ts',
  ])('%s enforces source authority after every cache miss', (path) => {
    expect(source(path)).toMatch(/isPublicRankingSourceAllowed|filterPublicRankingRows/)
  })
})
