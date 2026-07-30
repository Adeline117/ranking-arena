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

import { GET } from '../route'

describe('exchange OG rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
  })

  it('renders persisted safe-integer ranks, reserves medals for actual top three, and drops invalid ranks', async () => {
    const topQueryCalls: QueryCall[] = []
    mockFrom
      .mockReturnValueOnce(
        makeQuery(
          {
            data: [
              {
                source_trader_id: 'rank-one',
                handle: 'Rank One',
                avatar_url: null,
                roi: 30,
                arena_score: 99,
                rank: 1,
              },
              {
                source_trader_id: 'null-rank',
                handle: 'Null Rank',
                avatar_url: null,
                roi: 29,
                arena_score: 98,
                rank: null,
              },
              {
                source_trader_id: 'anonymous-id',
                handle: null,
                avatar_url: null,
                roi: 28,
                arena_score: 97,
                rank: 12,
              },
              {
                source_trader_id: 'fractional-rank',
                handle: 'Fractional Rank',
                avatar_url: null,
                roi: 27,
                arena_score: 96,
                rank: 2.5,
              },
              {
                source_trader_id: 'rank-two',
                handle: 'Rank Two',
                avatar_url: null,
                roi: 26,
                arena_score: 95,
                rank: 2,
              },
              {
                source_trader_id: 'unsafe-rank',
                handle: 'Unsafe Rank',
                avatar_url: null,
                roi: 25,
                arena_score: 94,
                rank: Number.MAX_SAFE_INTEGER + 1,
              },
            ],
            error: null,
          },
          topQueryCalls
        )
      )
      .mockReturnValueOnce(makeQuery({ count: 42, error: null }))

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
    expect(text).not.toContain('Null Rank')
    expect(text).not.toContain('Fractional Rank')
    expect(text).not.toContain('Unsafe Rank')

    const select = topQueryCalls.find(({ method }) => method === 'select')
    expect(select?.args[0]).toBe('source_trader_id, handle, avatar_url, roi, arena_score, rank')
    expect(
      topQueryCalls.filter(({ method }) => method === 'order').map(({ args }) => args)
    ).toEqual([
      ['rank', { ascending: true, nullsFirst: false }],
      ['arena_score', { ascending: false, nullsFirst: false }],
    ])
  })

  it('uses a stable source identity for an anonymous handle instead of a positional trader name', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [
            {
              source_trader_id: 'anonymous-id',
              handle: null,
              avatar_url: null,
              roi: 20,
              arena_score: 90,
              rank: 12,
            },
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

  it('excludes ranked rows whose ROI or Arena Score is non-finite', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [
            {
              source_trader_id: 'non-finite-roi-nan',
              handle: 'Non-finite ROI NaN',
              avatar_url: null,
              roi: Number.NaN,
              arena_score: 90,
              rank: 4,
            },
            {
              source_trader_id: 'non-finite-score-infinity',
              handle: 'Non-finite Score Infinity',
              avatar_url: null,
              roi: 20,
              arena_score: Number.POSITIVE_INFINITY,
              rank: 5,
            },
            {
              source_trader_id: 'non-finite-roi-infinity',
              handle: 'Non-finite ROI Infinity',
              avatar_url: null,
              roi: Number.NEGATIVE_INFINITY,
              arena_score: 80,
              rank: 6,
            },
            {
              source_trader_id: 'non-finite-score-nan',
              handle: 'Non-finite Score NaN',
              avatar_url: null,
              roi: 10,
              arena_score: Number.NaN,
              rank: 7,
            },
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
})
