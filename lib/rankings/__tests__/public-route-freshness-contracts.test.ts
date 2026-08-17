import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public ranking freshness route contracts', () => {
  it.each([
    'app/api/rankings/route.ts',
    'app/api/traders/route.ts',
    'app/api/v2/rankings/route.ts',
  ])('%s reads source watermarks and uses the shared fail-closed summary', (path) => {
    const route = source(path)
    expect(route).toContain("from('leaderboard_source_freshness')")
    expect(route).toContain("select('source,source_as_of')")
    expect(route).toContain('summarizeSourceFreshness(')
  })

  it('the main and v2 endpoints do not derive public freshness from score compute time', () => {
    const main = source('app/api/traders/route.ts')
    const v2 = source('app/api/v2/rankings/route.ts')

    expect(main).not.toContain('const computedAt =')
    expect(main).not.toMatch(/isStale\s*=\s*dataAgeMs/)
    expect(v2).not.toMatch(/latestUpdate[\s\S]*r\.computed_at/)
    expect(v2).toContain('updated_at: freshnessSummary.asOf')
  })

  it('the retired composite cache command cannot read or publish source freshness during V1', () => {
    const route = source('app/api/cron/precompute-composite/route.ts')

    expect(route).toContain('v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()')
    expect(route).not.toContain('leaderboard_source_freshness')
    expect(route).not.toContain('publicRankingCacheKey')
    expect(route).not.toContain('request.nextUrl')
  })

  it('SSR derives its timestamp from the complete live source generation', () => {
    const ssr = source('lib/getInitialTraders.ts')

    expect(ssr).toContain('summarizeInitialTraderFreshness({')
    expect(ssr).toContain('currentScoredSources(params.countRows)')
    expect(ssr).toContain('lastUpdated: freshness.asOf')
    expect(ssr).toContain('home-initial-traders-v4')
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
