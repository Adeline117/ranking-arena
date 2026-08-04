import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARENA_CONFIG, ARENA_V4_CONFIG } from '@/lib/utils/arena-score'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public product fact wiring', () => {
  it('uses live/fallback product facts on About instead of static trader/exchange claims', () => {
    const about = source('app/(app)/(legal)/about/AboutPageClient.tsx')

    expect(about).toContain('useProductFacts()')
    expect(about).toContain('productFacts.rankedTraderCount')
    expect(about).toContain('productFacts.sourceBoardCount')
    expect(about).not.toContain("value: t('aboutStatTraders')")
    expect(about).not.toContain("value: t('aboutStatExchanges')")
  })

  it('keeps public methodology weights bound to the scoring implementation', () => {
    const methodology = source('app/(app)/methodology/MethodologyPageClient.tsx')

    expect(methodology).toContain('ARENA_V4_CONFIG.W.pnl.toFixed(2)')
    expect(methodology).toContain("ARENA_CONFIG.OVERALL_WEIGHTS['90D']")
    expect(ARENA_V4_CONFIG.W).toEqual({ pnl: 0.3, roi: 0.2, dd: 0.2, sharpe: 0.2, con: 0.1 })
    expect(ARENA_CONFIG.OVERALL_WEIGHTS).toEqual({ '90D': 0.7, '30D': 0.25, '7D': 0.05 })
  })

  it('uses the bounded health authority on Status without a second stale clock', () => {
    const status = source('app/(app)/status/page.tsx')

    expect(status).toContain("fetch('/api/health'")
    expect(status).toContain('STATUS_FETCH_TIMEOUT_MS = 12_000')
    expect(status).toContain('health?.checks.freshness?.details')
    expect(status).toContain('latestSuccessfulPublicationAt')
    expect(status).toContain('PRODUCT_FACTS.leaderboardRefreshHours')
    expect(status).not.toContain('/api/platforms/health')
    expect(status).not.toContain('STALE_MS')
  })
})
