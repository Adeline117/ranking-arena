import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

const rankNotNull = /\.not\(\s*['"]rank['"]\s*,\s*['"]is['"]\s*,\s*null\s*\)/g

describe('public ranked-cohort reader contract', () => {
  it.each([
    'app/api/traders/route.ts',
    'app/api/rankings/route.ts',
    'app/api/rankings/live/route.ts',
    'app/api/v2/rankings/route.ts',
    'app/api/v3/route.ts',
    'lib/getInitialTraders.ts',
    'lib/data/trader/queries.ts',
    'app/api/export/rankings/route.ts',
    'app/api/sidebar/top-traders/route.ts',
    'app/(quiz)/quiz/result/page.tsx',
  ])('%s excludes unpublished rank rows in PostgREST', (path) => {
    expect(source(path).match(rankNotNull)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it.each([
    ['app/(app)/exchange/[slug]/page.tsx', 2],
    ['app/api/og/exchange/route.tsx', 2],
    ['app/api/recommendations/content/route.ts', 2],
    ['lib/data/trader/similar.ts', 2],
    ['lib/data/trader-queries.ts', 2],
    ['lib/recommendations/personal.ts', 4],
  ] as const)('%s guards every ranked cohort query', (path, minimum) => {
    expect(source(path).match(rankNotNull)?.length ?? 0).toBeGreaterThanOrEqual(minimum)
  })

  it('keeps live and unified public cohorts off positional Redis rank', () => {
    for (const path of ['app/api/rankings/live/route.ts', 'lib/data/trader/queries.ts']) {
      const contents = source(path)
      expect(contents).not.toContain('@/lib/realtime/ranking-store')
      expect(contents).not.toMatch(/getTopTraders(?:WithDetails)?\s*\(/)
      expect(contents).not.toMatch(/getSortedSetSize\s*\(/)
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
