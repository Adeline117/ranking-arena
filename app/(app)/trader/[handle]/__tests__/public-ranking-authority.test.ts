import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public trader-profile ranking authority', () => {
  it.each([
    'app/(app)/trader/[handle]/page.tsx',
    'app/(app)/u/[handle]/page.tsx',
    'app/api/trader/[platform]/[trader_key]/route.ts',
  ])('%s delegates anonymous rank fields to the sealed profile cohort', (path) => {
    const contents = source(path)
    expect(contents).toContain('fetchPublicProfileRankingRows')
    expect(contents).not.toMatch(/\.from\(\s*['"]leaderboard_ranks['"]\s*\)/)
  })

  it('does not coerce an unknown legacy API ROI or PnL to zero', () => {
    const route = source('app/api/trader/[platform]/[trader_key]/route.ts')
    expect(route).toContain('roi: snap.roi,')
    expect(route).toContain('pnl: snap.pnl,')
    expect(route).not.toContain('roi: snap.roi ?? 0')
    expect(route).not.toContain('pnl: snap.pnl ?? 0')
    expect(route).toContain('ranking_visibility: rankingCohort.rankingVisibility')
  })

  it('does not use a cross-request ranked payload cache as a publication proof', () => {
    const traderPage = source('app/(app)/trader/[handle]/page.tsx')
    const userPage = source('app/(app)/u/[handle]/page.tsx')
    const legacyRoute = source('app/api/trader/[platform]/[trader_key]/route.ts')
    const canonicalRoute = source('app/api/traders/[handle]/route.ts')

    expect(traderPage).toContain('export const revalidate = 0')
    expect(traderPage).not.toContain('cachedGetTraderDetailISR')
    expect(traderPage).not.toContain('cachedServingScores')
    expect(traderPage).not.toContain('cachedLeaderboardMeta')
    expect(userPage).toContain("cache: 'no-store'")
    expect(legacyRoute).not.toContain('tieredGet<PublicTraderDetailResponse>')
    expect(legacyRoute).not.toContain('tieredSet(cacheKey')
    expect(canonicalRoute).not.toContain('tieredGetOrSet(')
    expect(canonicalRoute).toContain("'Cache-Control': 'private, no-store, max-age=0'")
  })
})
