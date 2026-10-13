import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('/api/compare historical-series quarantine wiring', () => {
  it('reads the sealed current-ranking cohort on every request', () => {
    const route = read('app/api/compare/route.ts')

    expect(route).toContain('fetchPublicProfileRankingRows')
    expect(route).toContain('private, no-store, max-age=0, must-revalidate')
    expect(route).not.toContain('getOrSetWithLock')
    expect(route).not.toContain('tieredGetOrSet')
    expect(route).not.toContain('publicRankingCacheKey')
    expect(route).not.toContain('compare:current-ranked')
    expect(route).not.toContain('getTraderDetail')
    expect(route).not.toContain('toTraderPageData')
    expect(route).not.toContain('equityCurve')
    expect(route).not.toContain('equity_curve')
    expect(route).not.toContain('include_equity')
    expect(route).not.toContain('compare:trader:')
  })

  it('cannot request or render the retired curve projection', () => {
    const client = read('app/(app)/compare/ComparePageClient.tsx')
    const comparison = read('app/components/premium/TraderComparison.tsx')
    const identity = read('lib/compare/identity.ts')

    expect(client).toContain('buildCompareApiUrl(accounts)')
    expect(client).not.toContain('includeEquity')
    expect(client).not.toContain('equity_curve')
    expect(client).not.toContain('ft.roi ?? 0')
    expect(comparison).not.toContain('EquityCurveOverlay')
    expect(comparison).not.toContain('equity_curve')
    expect(comparison).not.toContain("'equity'")
    expect(comparison).not.toContain('compareEquityCurve')
    expect(comparison).not.toContain('value ?? 0')
    expect(comparison).toContain('ranking_visibility')
    expect(identity).not.toContain('includeEquity')
  })
})
