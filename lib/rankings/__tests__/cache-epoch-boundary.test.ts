import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

const publicRankedViewRead =
  /\.from\(\s*(?:['"]public_ranked_leaderboard['"]|PUBLIC_RANKED_LEADERBOARD(?:\s+as\s+never)?)\s*\)/
const rawLeaderboardRankRead = /\.from\(\s*['"]leaderboard_ranks['"]\s*\)/
const rawLeaderboardCountRead = /\.from\(\s*['"]leaderboard_count_cache['"]\s*\)/

function expectNoRawPublicRankingRelation(contents: string) {
  expect(contents).not.toMatch(rawLeaderboardRankRead)
  expect(contents).not.toMatch(rawLeaderboardCountRead)
}

describe('public ranking cache epoch boundary', () => {
  it.each([
    [
      'app/api/traders/route.ts',
      'sanitizePublicRankedCohort(cachedCohort, cacheParams)',
      'public_ranked_leaderboard',
    ],
    [
      'app/api/sidebar/top-traders/route.ts',
      'sanitizeSidebarCohort(cached)',
      'public_ranked_leaderboard',
    ],
    [
      'app/api/traders/[handle]/badges/route.ts',
      'sanitizeBadgeCohort(cached, scope)',
      'public_ranked_leaderboard',
    ],
    [
      'lib/getInitialTraders.ts',
      'sanitizeInitialTradersResult(cached, timeRange, { fromCache: true })',
      'getLeaderboard(supabase,',
    ],
  ] as const)(
    '%s uses a publication-scoped cache key and revalidates the cached cohort',
    (path, revalidation, authority) => {
      const contents = source(path)

      expect(contents).toContain('publicRankingCacheKey')
      expect(contents).toContain(revalidation)
      expect(contents).toContain(authority)
      expect(contents).toMatch(/sanitizePublicRankingPayload/)
      expectNoRawPublicRankingRelation(contents)
    }
  )

  // Keep the sorted-set key checks owned by the realtime store intact. Its
  // retained raw writer is an internal cache-builder, not a public reader.
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
    'app/api/cron/precompute-composite/route.ts',
    'app/api/rankings/movers/route.ts',
    'app/api/rankings/platform-stats/route.ts',
  ])('%s keeps its derivative cache key inside the publication epoch', (path) => {
    expect(source(path)).toContain('publicRankingCacheKey')
  })

  it.each([
    'app/api/rankings/route.ts',
    'app/api/rankings/live/route.ts',
    'app/api/v2/rankings/route.ts',
    'app/api/v3/route.ts',
    'app/api/export/rankings/route.ts',
  ])('%s bypasses response caches and directly validates the sealed view', (path) => {
    const contents = source(path)

    expect(contents).toContain('no-store')
    expect(contents).toMatch(publicRankedViewRead)
    expect(contents).toContain('sanitizePublicRankingPayload')
    expect(contents).not.toMatch(/tieredGet\(|tieredSet\(|tieredGetOrSet\(|getOrSetWithLock\(/)
    expectNoRawPublicRankingRelation(contents)
  })

  it('hot recommendations use a no-store route and a fresh sealed-view probe', () => {
    const route = source('app/api/recommendations/hot/route.ts')
    const reader = source('lib/recommendations/hot-score.ts')

    expect(route).toContain('no-store')
    expect(route).toContain('computeHotTraders')
    expect(route).not.toMatch(/tieredGet\(|tieredSet\(|tieredGetOrSet\(|getOrSetWithLock\(/)
    expect(reader).toMatch(publicRankedViewRead)
    expect(reader).toContain('sanitizePublicRankingPayload')
    expectNoRawPublicRankingRelation(route)
    expectNoRawPublicRankingRelation(reader)
  })

  it.each([
    'app/api/trader/[platform]/[trader_key]/route.ts',
    'app/api/traders/[handle]/full/route.ts',
    'app/api/traders/[handle]/route.ts',
    'lib/data/trader/similar.ts',
  ])('%s does not treat a cached ranked payload as current publication proof', (path) => {
    const contents = source(path)
    expect(contents).not.toMatch(/tieredGet\(|tieredSet\(|tieredGetOrSet\(|getOrSetWithLock\(/)
    expectNoRawPublicRankingRelation(contents)
  })
})
