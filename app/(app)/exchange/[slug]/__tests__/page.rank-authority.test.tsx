import React from 'react'

const mockFrom = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom }),
}))

jest.mock('next/navigation', () => ({
  notFound: jest.fn(),
  redirect: jest.fn(),
}))

jest.mock('@/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    t: (key: string) =>
      (
        ({
          dataUnknown: 'Unknown',
          exchangePageSubtitle: '{count} ranked traders on {name} ({type}).',
          exchangePageAboutBody: 'Arena tracks {count} active traders on {name}.',
          exchangePageSubtitleEmpty: '{name} ({type}) has no published ranking right now.',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: 'page-header',
}))

interface QueryCall {
  method: string
  args: unknown[]
}

function makeQuery(
  result: { data?: unknown[] | null; error: unknown; count?: number | null },
  calls?: QueryCall[]
) {
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn((...args: unknown[]) => {
          calls?.push({ method: String(property), args })
          return proxy
        })
      },
    }
  )
  return proxy
}

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-id',
    handle: 'Trader',
    arena_score: 99,
    roi: 30,
    pnl: 1000,
    win_rate: 60,
    max_drawdown: 20,
    rank: 1,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '90D',
    ...overrides,
  }
}

type ElementProps = { children?: React.ReactNode; subtitle?: string }

function findElementByType(node: React.ReactNode, type: unknown): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByType(child, type)
      if (found) return found
    }
    return null
  }
  if (!React.isValidElement(node)) return null
  if (node.type === type) return node
  return findElementByType((node.props as ElementProps).children, type)
}

import ExchangeLandingPage, { generateMetadata } from '../page'

describe('exchange landing page public rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reads both rankings and the displayed total from the verified public view', async () => {
    const topQueryCalls: QueryCall[] = []
    const countQueryCalls: QueryCall[] = []
    mockFrom
      .mockReturnValueOnce(
        makeQuery(
          {
            data: [publicRankedRow({ handle: 'Rank One', source_trader_id: 'rank-one' })],
            error: null,
          },
          topQueryCalls
        )
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }, countQueryCalls))

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'binance' }) })

    expect(metadata.description).toEqual(expect.stringContaining('42 ranked Binance traders'))
    expect(metadata.description).toEqual(
      expect.stringContaining('Top trader: Rank One (+30.0% ROI)')
    )
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(mockFrom).toHaveBeenNthCalledWith(1, 'public_ranked_leaderboard')
    expect(mockFrom).toHaveBeenNthCalledWith(2, 'public_ranked_leaderboard')
    expect(topQueryCalls.find(({ method }) => method === 'select')?.args[0]).toBe(
      'source,source_trader_id,handle,arena_score,roi,pnl,win_rate,max_drawdown,rank,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'
    )
    expect(countQueryCalls.find(({ method }) => method === 'select')?.args).toEqual([
      '*',
      { count: 'exact', head: true },
    ])
  })

  it('renders an explicit unknown count rather than a page-length or failed exact count', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [publicRankedRow({ handle: 'Rank One', source_trader_id: 'rank-one' })],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ count: 0, error: null }))

    const page = await ExchangeLandingPage({ params: Promise.resolve({ slug: 'binance' }) })
    const header = findElementByType(page, 'page-header')

    expect((header?.props as ElementProps | undefined)?.subtitle).toContain('Unknown')
    expect((header?.props as ElementProps | undefined)?.subtitle).not.toContain('1 ranked')
  })

  it('says the board is unpublished instead of "0 ranked traders" when it is empty', async () => {
    mockFrom
      .mockReturnValueOnce(makeQuery({ data: [], error: null }))
      .mockReturnValueOnce(makeQuery({ count: 0, error: null }))

    const page = await ExchangeLandingPage({ params: Promise.resolve({ slug: 'binance' }) })
    const subtitle = (findElementByType(page, 'page-header')?.props as ElementProps | undefined)
      ?.subtitle

    expect(subtitle).toContain('no published ranking')
    expect(subtitle).not.toMatch(/\b0 ranked/)
  })

  it('does not render a top-trader metadata claim after a malformed cohort row', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [
            publicRankedRow({ handle: 'Rank One', source_trader_id: 'rank-one' }),
            publicRankedRow({
              source_trader_id: 'partial-row',
              handle: 'Partial Row',
              metrics_estimated: true,
              rank: 2,
            }),
          ],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }))

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'binance' }) })

    expect(metadata.description).toEqual(expect.stringContaining('42 ranked Binance traders'))
    expect(metadata.description).not.toEqual(expect.stringContaining('Top trader:'))
  })

  it('does not query raw retained observations for a quarantined exchange', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'bingx' }) })

    expect(mockFrom).not.toHaveBeenCalled()
    expect(metadata.description).not.toEqual(expect.stringContaining('ranked BingX traders'))
  })
})

describe('exchange landing page counts traders with performance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const idleFilter = (calls: QueryCall[]) =>
    calls.filter(({ method, args }) => method === 'eq' && args[0] === 'idle_window')

  it('leaves idle-window rows out of the count and of the top list alike', async () => {
    const topQueryCalls: QueryCall[] = []
    const countQueryCalls: QueryCall[] = []
    mockFrom
      .mockReturnValueOnce(
        makeQuery(
          {
            data: [publicRankedRow({ handle: 'Rank One', source_trader_id: 'rank-one' })],
            error: null,
          },
          topQueryCalls
        )
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }, countQueryCalls))

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'binance' }) })

    // One predicate on both queries: a count below the rows shown would be
    // read as unknown.
    expect(idleFilter(topQueryCalls).map(({ args }) => args)).toEqual([['idle_window', false]])
    expect(idleFilter(countQueryCalls).map(({ args }) => args)).toEqual([['idle_window', false]])
    // Old rule (full rows, none idle): the predicate removes nothing and the
    // page says what it said before.
    expect(metadata.description).toEqual(expect.stringContaining('42 ranked Binance traders'))
    expect(metadata.description).toEqual(
      expect.stringContaining('Top trader: Rank One (+30.0% ROI)')
    )
  })

  it('shows no published ranking for an exchange served only through idle rows', async () => {
    // With the predicate both queries come back empty for such an exchange.
    mockFrom
      .mockReturnValueOnce(makeQuery({ data: [], error: null }))
      .mockReturnValueOnce(makeQuery({ count: 0, error: null }))

    const page = await ExchangeLandingPage({ params: Promise.resolve({ slug: 'binance' }) })
    const subtitle = (findElementByType(page, 'page-header')?.props as ElementProps | undefined)
      ?.subtitle

    expect(subtitle).toContain('no published ranking')
  })
})
