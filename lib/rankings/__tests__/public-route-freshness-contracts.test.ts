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
  ])('%s binds rows and metadata to a sealed publication generation', (path) => {
    const route = source(path)
    expect(route).toContain('readSealedRankingGeneration')
    expect(route).toContain('rank_publication_id')
    expect(route).not.toContain("from('leaderboard_source_freshness')")
  })

  it('the main and v2 endpoints do not derive public freshness from score compute time', () => {
    const main = source('app/api/traders/route.ts')
    const v2 = source('app/api/v2/rankings/route.ts')

    expect(main).not.toContain('const computedAt =')
    expect(main).not.toMatch(/isStale\s*=\s*dataAgeMs/)
    expect(v2).not.toMatch(/latestUpdate[\s\S]*r\.computed_at/)
    expect(v2).toContain('updated_at: freshnessSummary.asOf')
  })

  it('the composite endpoint reads all three dynamic authorities and exact cohorts', () => {
    const route = source('app/api/rankings/route.ts')
    const reader = source('lib/rankings/read-sealed-composite-ranking-generation.ts')
    const rpc = source('lib/rankings/read-composite-ranking-page.ts')

    expect(route).toContain('readSealedCompositeRankingGeneration(')
    expect(route).toContain('readCompositeRankingPageWithDatabaseTimeout(')
    expect(route).not.toContain("? { ...sealedRead.value, window: 'COMPOSITE'")
    expect(reader).toContain("['7D', '30D', '90D']")
    expect(reader).toContain('readLeaderboardPublicationAuthority')
    expect(reader).toContain('readLeaderboardPublicationProofs')
    expect(rpc).toContain('p_7d_cohort_id: publication7d.scoreCohortId')
    expect(rpc).toContain('p_30d_cohort_id: publication30d.scoreCohortId')
    expect(rpc).toContain('p_90d_cohort_id: publication90d.scoreCohortId')
    expect(rpc).toContain('BEGIN TRANSACTION READ ONLY')
    expect(rpc).toContain('SET LOCAL statement_timeout')
  })

  it('the retired composite writer cannot read or cache unsealed rank rows', () => {
    const route = source('app/api/cron/precompute-composite/route.ts')

    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain('getPool')
    expect(route).not.toContain('tieredSet')
    expect(route).toContain('{ status: 410 }')
  })

  it('SSR derives its timestamp from the complete live source generation', () => {
    const ssr = source('lib/getInitialTraders.ts')

    expect(ssr).toContain('readSealedRankingAuthorityGeneration(')
    expect(ssr).toContain('publication.scoreCohortId')
    expect(ssr).toContain('publication.proofs')
    expect(ssr).toContain('categoryCountsFromPublication(publication)')
    expect(ssr).toContain('home-initial-traders-sealed-v6')
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
