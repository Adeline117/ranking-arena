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

  it('composite cache joins source watermarks and does not discard stale last-good ranks', () => {
    const route = source('app/api/cron/precompute-composite/route.ts')

    expect(route).toContain('LEFT JOIN leaderboard_source_freshness AS freshness')
    expect(route).toContain('freshness.source_as_of AS as_of_ts')
    expect(route).not.toContain('computed_at >= $2')
    expect(route).toContain("'precomputed:composite:all:v2'")
  })

  it('SSR derives its timestamp from the complete live source generation', () => {
    const ssr = source('lib/getInitialTraders.ts')

    expect(ssr).toContain('summarizeInitialTraderFreshness({')
    expect(ssr).toContain('currentScoredSources(params.countRows)')
    expect(ssr).toContain('lastUpdated: freshness.asOf')
    expect(ssr).toContain('home-initial-traders-v4')
  })
})
