import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

const rawLeaderboardRankRead = /\.from\(\s*['"]leaderboard_ranks['"]\s*\)/
const rawLeaderboardCountRead = /\.from\(\s*['"]leaderboard_count_cache['"]\s*\)/

describe('public ranking freshness route contracts', () => {
  it.each([
    'app/api/rankings/route.ts',
    'app/api/traders/route.ts',
    'app/api/v2/rankings/route.ts',
  ])('%s binds public freshness to observed source watermarks from the sealed view', (path) => {
    const route = source(path)

    expect(route).toContain("from('public_ranked_leaderboard')")
    expect(route).toContain('sanitizePublicRankingPayload')
    expect(route).toContain('no-store')
    expect(route).toContain("from('leaderboard_source_freshness')")
    expect(route).toContain("select('source,source_as_of')")
    expect(route).toContain('summarizeSourceFreshness(')
    expect(route).not.toMatch(rawLeaderboardRankRead)
    expect(route).not.toMatch(rawLeaderboardCountRead)
  })

  it('the main and v2 endpoints do not turn score compute time into public freshness', () => {
    const main = source('app/api/traders/route.ts')
    const v2 = source('app/api/v2/rankings/route.ts')

    // `computed_at` remains a cache-row age guard. Its existence must not be
    // mistaken for the response freshness authority, which is source_as_of.
    // The guard now delegates to the shared cohort predicate, which reads
    // computed_at only as a row-age bound.
    expect(main).toMatch(
      /function isWithinPublicServingFreshness[\s\S]*?computed_at: row\.computed_at/
    )
    expect(main).toContain('lastUpdated: freshnessSummary.asOf')
    expect(main).not.toMatch(/lastUpdated:\s*(?:row\.)?computed_at/)
    expect(main).not.toMatch(/isStale\s*=\s*dataAgeMs/)
    expect(v2).not.toMatch(/latestUpdate[\s\S]*r\.computed_at/)
    expect(v2).toContain('updated_at: freshnessSummary.asOf')
  })

  it('platform health never exposes raw score computation time as source freshness', () => {
    const route = source('app/api/platforms/health/route.ts')

    expect(route).not.toMatch(rawLeaderboardRankRead)
    expect(route).not.toMatch(/select\([^)]*computed_at/)
    expect(route).not.toContain('updated_at:computed_at')
    expect(route).not.toContain('getOrSetWithLock')
    expect(route).toContain(
      "freshness_visibility: latestByPlatform.size > 0 ? ('verified' as const) : ('unknown' as const)"
    )
    expect(route).toContain("'Cache-Control': 'private, no-store, max-age=0, must-revalidate'")
    // The /status page reads the registry freshness authority via /api/health
    // (see lib/config/__tests__/public-fact-wiring.test.ts), not this route.
  })

  it('the retired composite cache command cannot read or publish source freshness during V1', () => {
    const route = source('app/api/cron/precompute-composite/route.ts')

    expect(route).toContain('v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()')
    expect(route).not.toContain('leaderboard_source_freshness')
    expect(route).not.toContain('publicRankingCacheKey')
    expect(route).not.toContain('request.nextUrl')
  })

  it('SSR v7 derives its timestamp from the observed page sources and revalidates cached proof', () => {
    const ssr = source('lib/getInitialTraders.ts')

    expect(ssr).toContain('summarizeInitialTraderFreshness({')
    expect(ssr).toContain('observedSources: enrichedTraders.map((trader) => trader.source)')
    expect(ssr).toContain('observedSources: proofValidTraders.map((trader) => trader.source)')
    expect(ssr).toContain(
      'return summarizeSourceFreshness(params.watermarkRows, sources, params.nowMs)'
    )
    expect(ssr).toContain("from('leaderboard_source_freshness')")
    expect(ssr).toContain("select('source,source_as_of')")
    expect(ssr).toContain('sanitizePublicRankingPayload')
    expect(ssr).toContain('lastUpdated: freshness.asOf')
    expect(ssr).toContain('home-initial-traders-v7')
    expect(ssr).not.toMatch(rawLeaderboardRankRead)
    expect(ssr).not.toMatch(rawLeaderboardCountRead)
  })

  it('homepage carries the SSR stale flag into the interactive freshness state', () => {
    const page = source('app/page.tsx')
    const loader = source('app/components/home/HomePageLoader.tsx')
    const home = source('app/components/home/HomePage.tsx')
    const client = source('app/components/home/HomePageClient.tsx')

    expect(page).toContain('initialIsStale={isStale}')
    expect(loader).toContain('initialIsStale?: boolean')
    expect(home).toContain('initialIsStale={initialIsStale}')
    expect(client).toContain('initialIsStale,')
    expect(client).toContain('isStale={isStale}')
  })
})
