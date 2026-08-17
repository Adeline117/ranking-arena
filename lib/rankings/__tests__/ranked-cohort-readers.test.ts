import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function sourceSection(path: string, start: string, end: string): string {
  const contents = source(path)
  const startIndex = contents.indexOf(start)
  if (startIndex < 0) throw new Error(`${path} is missing section start: ${start}`)

  const endIndex = contents.indexOf(end, startIndex + start.length)
  if (endIndex < 0) throw new Error(`${path} is missing section end: ${end}`)

  return contents.slice(startIndex, endIndex)
}

const rankNotNull = /\.not\(\s*['"]rank['"]\s*,\s*['"]is['"]\s*,\s*null\s*\)/g
const publicRankedViewRead =
  /\.from\(\s*(?:['"]public_ranked_leaderboard['"]|PUBLIC_RANKED_LEADERBOARD(?:\s+as\s+never)?)\s*\)/
const rawLeaderboardRankRead = /\.from\(\s*['"]leaderboard_ranks['"]\s*\)/
const rawLeaderboardCountRead = /\.from\(\s*['"]leaderboard_count_cache['"]\s*\)/
const cohortSanitizer =
  /sanitizePublicRankingPayload|sanitizePublicProfileRankingRows|verifyTraderRecommendationCohort/

function expectNoRawPublicRankingRelation(contents: string) {
  expect(contents).not.toMatch(rawLeaderboardRankRead)
  expect(contents).not.toMatch(rawLeaderboardCountRead)
}

function expectVerifiedDirectCohortReader(contents: string) {
  expect(contents).toMatch(publicRankedViewRead)
  expect(contents).toMatch(cohortSanitizer)
  expectNoRawPublicRankingRelation(contents)
}

describe('public ranked-cohort reader contract', () => {
  it.each([
    'app/api/traders/route.ts',
    'app/api/rankings/route.ts',
    'app/api/rankings/live/route.ts',
    'app/api/v2/rankings/route.ts',
    'app/api/v3/route.ts',
    'app/api/export/rankings/route.ts',
    'app/api/sidebar/top-traders/route.ts',
    'app/api/traders/[handle]/badges/route.ts',
    'app/(quiz)/quiz/result/page.tsx',
    'app/(app)/compare/layout.tsx',
    'app/(app)/exchange/[slug]/page.tsx',
    'app/(app)/wrapped/[handle]/page.tsx',
    'app/(app)/share/rank/[trader_key]/page.tsx',
    'app/api/og/exchange/route.tsx',
    'app/api/recommendations/content/route.ts',
    'lib/data/trader/similar.ts',
    'lib/data/trader/public-profile-ranking.ts',
    'lib/recommendations/hot-score.ts',
  ])('%s reads rank-bearing data only from the sealed view and revalidates it', (path) => {
    expectVerifiedDirectCohortReader(source(path))
  })

  it('the unified leaderboard reader keeps its rank query on the sealed view', () => {
    const leaderboard = sourceSection(
      'lib/data/trader/queries.ts',
      'export async function getLeaderboard(',
      '/**\n * Get full trader detail'
    )

    expect(leaderboard).toMatch(publicRankedViewRead)
    expect(leaderboard).toContain('isPublicRankingSourceAllowed')
    expectNoRawPublicRankingRelation(leaderboard)
  })

  it('homepage cache rows retain proof fields and are revalidated before rendering', () => {
    const homepage = source('lib/getInitialTraders.ts')

    expect(homepage).toContain('publicRankingCacheKey')
    expect(homepage).toContain('sanitizePublicRankingPayload')
    expect(homepage).toContain('getLeaderboard(supabase,')
    expect(homepage).toContain(
      'sanitizeInitialTradersResult(cached, timeRange, { fromCache: true })'
    )
    expectNoRawPublicRankingRelation(homepage)
  })

  it.each([
    'app/api/rankings/route.ts',
    'app/api/rankings/live/route.ts',
    'app/api/v2/rankings/route.ts',
    'app/api/v3/route.ts',
    'app/api/export/rankings/route.ts',
    'app/api/rankings/movers/route.ts',
    'app/api/sidebar/top-traders/route.ts',
    'app/api/traders/[handle]/badges/route.ts',
    'app/(quiz)/quiz/result/page.tsx',
    'app/(app)/exchange/[slug]/page.tsx',
    'app/api/og/exchange/route.tsx',
    'app/api/recommendations/content/route.ts',
    'lib/data/trader/similar.ts',
    'lib/recommendations/hot-score.ts',
  ])('%s keeps an explicit persisted-rank query prefilter where it has one', (path) => {
    expect(source(path).match(rankNotNull)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('movers can cache only an unavailable historical-ranking state, never raw rank rows', () => {
    const movers = source('app/api/rankings/movers/route.ts')

    expect(movers).toMatch(publicRankedViewRead)
    expect(movers).toContain('unavailableMovers')
    expect(movers).toMatch(/risers:\s*\[\]/)
    expect(movers).toMatch(/fallers:\s*\[\]/)
    expect(movers).not.toContain('@/lib/analytics/queries')
    expectNoRawPublicRankingRelation(movers)
  })

  it('profile routes delegate rank fields to the no-store public-profile cohort reader', () => {
    const profileReader = source('lib/data/trader/public-profile-ranking.ts')
    expectVerifiedDirectCohortReader(profileReader)

    const routes = [
      ['app/api/trader/[platform]/[trader_key]/route.ts', 'fetchPublicProfileRankingRows'],
      ['app/api/traders/[handle]/route.ts', 'getTraderDetail'],
      ['app/api/traders/[handle]/full/route.ts', 'getTraderDetail'],
    ] as const

    for (const [path, reader] of routes) {
      const contents = source(path)
      expect(contents).toContain('no-store')
      expect(contents).toContain(reader)
      expect(contents).not.toMatch(/tieredGet\(|tieredSet\(|tieredGetOrSet\(|getOrSetWithLock\(/)
      expectNoRawPublicRankingRelation(contents)
    }
  })

  it('does not fabricate a publication rank from response position', () => {
    const forbiddenByFile: Array<[string, RegExp]> = [
      ['app/api/rankings/route.ts', /offset\s*\+\s*idx\s*\+\s*1/],
      ['app/api/v3/route.ts', /rank\s*=\s*offset\s*\+/],
      ['app/api/og/exchange/route.tsx', /rank:\s*i\s*\+\s*1/],
      ['app/(app)/exchange/[slug]/page.tsx', /rank:\s*i\s*\+\s*1/],
      ['app/components/home/HomePageClient.tsx', /rank:\s*idx\s*\+\s*1/],
      ['app/components/home/SSRRankingTable.tsx', /startRank\s*\+\s*idx\s*\+\s*1/],
      ['app/components/ranking/RankingFilters.tsx', /rank:\s*i\s*\+\s*1/],
    ]

    for (const [path, forbidden] of forbiddenByFile) {
      expect(source(path)).not.toMatch(forbidden)
    }
  })
})
