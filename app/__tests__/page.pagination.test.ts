jest.mock('@/lib/getInitialTraders', () => ({ getInitialTraders: jest.fn() }))
jest.mock('@/lib/data/hero-stats', () => ({ getHeroStats: jest.fn() }))
jest.mock('../components/home/SSRRankingTable', () => () => null)
jest.mock('../components/home/HomeHeroSSR', () => () => null)
jest.mock('../components/home/RankingControls', () => () => null)
jest.mock(
  '../components/home/HomeFirstPaintShell',
  () =>
    ({ children }: { children: unknown }) =>
      children
)
jest.mock('../components/layout/TopNav', () => () => null)
jest.mock('../components/home/HomePageLoader', () => () => null)
jest.mock('../components/Providers/Accessibility', () => ({ SkipLink: () => null }))
jest.mock('../components/Providers/JsonLd', () => ({ JsonLd: () => null }))
jest.mock('../components/utils/ErrorBoundary', () => ({
  PageErrorBoundary: ({ children }: { children: unknown }) => children,
}))

import { parseHomeRankingQuery } from '../page'

describe('homepage ranking URL boundary', () => {
  it('maps the public one-based page and range to the exact SSR reader cohort', () => {
    expect(parseHomeRankingQuery({ range: '30D', page: '3' })).toMatchObject({
      timeRange: '30D',
      pageIndex: 2,
      requiresClientCohortFetch: false,
      isCanonical: false,
    })
  })

  it('fails invalid/repeated page values closed to page zero', () => {
    expect(parseHomeRankingQuery({ page: '0' }).pageIndex).toBe(0)
    expect(parseHomeRankingQuery({ page: '1.5' }).pageIndex).toBe(0)
    expect(parseHomeRankingQuery({ page: ['2', '3'] }).pageIndex).toBe(0)
    expect(parseHomeRankingQuery({ page: '99999' }).pageIndex).toBe(0)
  })

  it('uses a stable full client cohort key and normalizes legacy alpha links to score', () => {
    const alpha = parseHomeRankingQuery({
      page: '2',
      range: '30D',
      sort: 'alpha',
      category: 'futures',
      ex: 'binance-futures',
    })
    const score = parseHomeRankingQuery({
      ex: 'binance-futures',
      category: 'futures',
      sort: 'score',
      range: '30D',
      page: '2',
    })
    const differentFilter = parseHomeRankingQuery({
      ex: 'bybit',
      category: 'futures',
      sort: 'score',
      range: '30D',
      page: '2',
    })

    expect(alpha.requiresClientCohortFetch).toBe(true)
    expect(alpha.clientCohortKey).toBe(score.clientCohortKey)
    expect(differentFilter.clientCohortKey).not.toBe(score.clientCohortKey)
  })

  it('attaches ItemList authority only to the canonical 90D first page', () => {
    expect(parseHomeRankingQuery({}).isCanonical).toBe(true)
    expect(parseHomeRankingQuery({ page: '1' }).isCanonical).toBe(false)
    expect(parseHomeRankingQuery({ range: '90D' }).isCanonical).toBe(false)
  })
})
