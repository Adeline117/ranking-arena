import React from 'react'

let mockImageTree: React.ReactNode = null

jest.mock('next/og', () => ({
  ImageResponse: jest.fn().mockImplementation((element: React.ReactNode) => {
    mockImageTree = element
    return { element }
  }),
}))

const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/rankings/public-response-cache', () => ({
  publicRankingResponseCacheHeaders: () => ({}),
  publicRankingResponseRejectionHeaders: () => ({}),
  redirectToPublicRankingResponseCacheEpoch: () => null,
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

type ElementProps = {
  children?: React.ReactNode
  style?: React.CSSProperties
}

function collectElements(node: React.ReactNode, found: React.ReactElement[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, found)
    return found
  }
  if (!React.isValidElement(node)) return found

  found.push(node)
  collectElements((node.props as ElementProps).children, found)
  return found
}

function collectText(node: React.ReactNode, found: string[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, found)
    return found
  }
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (React.isValidElement(node)) collectText((node.props as ElementProps).children, found)
  return found
}

function rankBadges() {
  return collectElements(mockImageTree).filter((element) => {
    const props = element.props as ElementProps
    return (
      element.type === 'span' &&
      props.style?.fontSize === 14 &&
      props.style?.fontWeight === 900 &&
      (typeof props.children === 'number' || typeof props.children === 'string')
    )
  })
}

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-id',
    handle: 'Trader',
    avatar_url: null,
    roi: 30,
    pnl: 1000,
    win_rate: 60,
    max_drawdown: 20,
    arena_score: 99,
    rank: 1,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '90D',
    ...overrides,
  }
}

import { GET } from '../route'

describe('exchange OG rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
  })

  it('renders persisted safe-integer ranks from the public cohort and reserves medals for actual top three', async () => {
    const topQueryCalls: QueryCall[] = []
    const countQueryCalls: QueryCall[] = []
    mockFrom
      .mockReturnValueOnce(
        makeQuery(
          {
            data: [
              publicRankedRow({ source_trader_id: 'rank-one', handle: 'Rank One', rank: 1 }),
              publicRankedRow({
                source_trader_id: 'anonymous-id',
                handle: null,
                rank: 12,
              }),
              publicRankedRow({ source_trader_id: 'rank-two', handle: 'Rank Two', rank: 2 }),
            ],
            error: null,
          },
          topQueryCalls
        )
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }, countQueryCalls))

    await GET({ url: 'https://arenafi.org/api/og/exchange?exchange=binance_futures' } as never)

    const badges = rankBadges()
    expect(badges.map((badge) => String((badge.props as ElementProps).children))).toEqual([
      '1',
      '12',
      '2',
    ])

    const colors = badges.map((badge) => (badge.props as ElementProps).style?.color)
    expect(colors[0]).toBe('#FFD700')
    expect(colors[1]).not.toBe('#FFD700')
    expect(colors[1]).not.toBe('#C0C0C0')
    expect(colors[1]).not.toBe('#CD7F32')
    expect(colors[2]).toBe('#C0C0C0')

    const text = collectText(mockImageTree)
    expect(text).toContain('42 ranked traders')

    const select = topQueryCalls.find(({ method }) => method === 'select')
    expect(select?.args[0]).toBe(
      'source,source_trader_id,handle,avatar_url,roi,pnl,win_rate,max_drawdown,arena_score,rank,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'
    )
    expect(
      topQueryCalls.filter(({ method }) => method === 'order').map(({ args }) => args)
    ).toEqual([
      ['rank', { ascending: true, nullsFirst: false }],
      ['arena_score', { ascending: false, nullsFirst: false }],
    ])
    expect(countQueryCalls.find(({ method }) => method === 'select')?.args).toEqual([
      '*',
      { count: 'exact', head: true },
    ])
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(mockFrom).toHaveBeenNthCalledWith(1, 'public_ranked_leaderboard')
    expect(mockFrom).toHaveBeenNthCalledWith(2, 'public_ranked_leaderboard')
  })

  it('uses a stable source identity for an anonymous handle instead of a positional trader name', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [
            publicRankedRow({
              source_trader_id: 'anonymous-id',
              handle: null,
              roi: 20,
              arena_score: 90,
              rank: 12,
            }),
          ],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ count: 1, error: null }))

    await GET({ url: 'https://arenafi.org/api/og/exchange?exchange=binance_futures' } as never)

    const text = collectText(mockImageTree)
    expect(text).toContain('anonymous-id')
    expect(text).not.toContain('Trader 1')
  })

  it('fails closed instead of replacing a malformed public row with later candidates', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [
            publicRankedRow({ source_trader_id: 'rank-one', handle: 'Rank One', rank: 1 }),
            publicRankedRow({
              source_trader_id: 'invalid-rank',
              handle: 'Invalid Rank',
              rank: null,
            }),
            publicRankedRow({ source_trader_id: 'rank-two', handle: 'Rank Two', rank: 2 }),
          ],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }))

    await GET({ url: 'https://arenafi.org/api/og/exchange?exchange=binance_futures' } as never)

    const text = collectText(mockImageTree)
    expect(text).toContain('Rankings coming soon')
    expect(text).toContain('Ranked trader count unavailable')
    expect(text).not.toContain('Rank One')
    expect(text).not.toContain('Rank Two')
    expect(rankBadges()).toHaveLength(0)
  })

  it('excludes ranked rows whose ROI or Arena Score is non-finite', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [
            publicRankedRow({
              source_trader_id: 'non-finite-roi-nan',
              handle: 'Non-finite ROI NaN',
              roi: Number.NaN,
              arena_score: 90,
              rank: 4,
            }),
            publicRankedRow({
              source_trader_id: 'non-finite-score-infinity',
              handle: 'Non-finite Score Infinity',
              roi: 20,
              arena_score: Number.POSITIVE_INFINITY,
              rank: 5,
            }),
            publicRankedRow({
              source_trader_id: 'non-finite-roi-infinity',
              handle: 'Non-finite ROI Infinity',
              roi: Number.NEGATIVE_INFINITY,
              arena_score: 80,
              rank: 6,
            }),
            publicRankedRow({
              source_trader_id: 'non-finite-score-nan',
              handle: 'Non-finite Score NaN',
              roi: 10,
              arena_score: Number.NaN,
              rank: 7,
            }),
          ],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ count: 4, error: null }))

    await GET({ url: 'https://arenafi.org/api/og/exchange?exchange=binance_futures' } as never)

    const text = collectText(mockImageTree)
    expect(text).toContain('Rankings coming soon')
    expect(text).not.toContain('Non-finite ROI NaN')
    expect(text).not.toContain('Non-finite Score Infinity')
    expect(text).not.toContain('Non-finite ROI Infinity')
    expect(text).not.toContain('Non-finite Score NaN')
    expect(text.some((value) => /NaN|Infinity/.test(value))).toBe(false)
    expect(rankBadges()).toHaveLength(0)
  })

  it('keeps valid cards but marks the count unknown when the exact view count fails', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [publicRankedRow({ source_trader_id: 'rank-one', handle: 'Rank One', rank: 1 })],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ count: null, error: { message: 'count unavailable' } }))

    await GET({ url: 'https://arenafi.org/api/og/exchange?exchange=binance_futures' } as never)

    const text = collectText(mockImageTree)
    expect(text).toContain('Rank One')
    expect(text).toContain('Ranked trader count unavailable')
    expect(text).not.toContain('0 ranked traders')
  })
})

describe('exchange OG counts traders with performance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
  })

  it('leaves idle-window rows out of the total and of the top traders alike', async () => {
    const topQueryCalls: QueryCall[] = []
    const countQueryCalls: QueryCall[] = []
    mockFrom
      .mockReturnValueOnce(
        makeQuery(
          {
            data: [publicRankedRow({ source_trader_id: 'rank-one', handle: 'Rank One', rank: 1 })],
            error: null,
          },
          topQueryCalls
        )
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }, countQueryCalls))

    await GET({ url: 'https://arenafi.org/api/og/exchange?exchange=binance_futures' } as never)

    for (const calls of [topQueryCalls, countQueryCalls]) {
      expect(
        calls
          .filter(({ method, args }) => method === 'eq' && args[0] === 'idle_window')
          .map(({ args }) => args)
      ).toEqual([['idle_window', false]])
    }
    // Old rule (full rows, none idle): same card as before.
    expect(collectText(mockImageTree)).toContain('42 ranked traders')
    expect(rankBadges().map((badge) => String((badge.props as ElementProps).children))).toEqual([
      '1',
    ])
  })
})
