import React from 'react'

let mockImageTree: React.ReactNode = null
const mockFrom = jest.fn()

jest.mock('next/og', () => ({
  ImageResponse: jest.fn().mockImplementation((element: React.ReactNode) => {
    mockImageTree = element
    return { element }
  }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/rankings/publication-policy', () => ({
  isPublicRankingSourceAllowed: (source: string) => source === 'binance_futures',
  sanitizePublicRankingPayload: ({ traders }: { traders: unknown[] }) => ({
    traders: traders.filter(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        (row as { score_completeness?: unknown }).score_completeness === 'full' &&
        (row as { metrics_estimated?: unknown }).metrics_estimated === false &&
        (row as { is_outlier?: unknown }).is_outlier === false
    ),
  }),
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

function query(result: { data: unknown; error: { message: string } | null }, calls: QueryCall[]) {
  const chain = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'maybeSingle') return jest.fn().mockResolvedValue(result)
        return jest.fn((...args: unknown[]) => {
          calls.push({ method: String(property), args })
          return chain
        })
      },
    }
  )
  return chain
}

type ElementProps = { children?: React.ReactNode }

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

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    rank: 3,
    roi: 12.5,
    win_rate: 68,
    arena_score: 91.5,
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '7D',
    ...overrides,
  }
}

import { GET } from '../route'

describe('share rank card public rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
  })

  it('renders only a verified view rank and never reads a raw count denominator', async () => {
    const sourceCalls: QueryCall[] = []
    const viewCalls: QueryCall[] = []
    mockFrom
      .mockReturnValueOnce(
        query(
          {
            data: {
              handle: 'Top Trader',
              source: 'binance_futures',
              source_trader_id: 'trader-1',
            },
            error: null,
          },
          sourceCalls
        )
      )
      .mockReturnValueOnce(query({ data: candidate(), error: null }, viewCalls))

    await GET({
      url: 'https://arenafi.org/api/share/rank-card?handle=Top%20Trader&platform=binance_futures&window=7d',
    } as never)

    expect(mockFrom.mock.calls.map(([relation]) => relation)).toEqual([
      'trader_sources',
      'public_ranked_leaderboard',
    ])
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_count_cache')
    expect(viewCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'select',
          args: [expect.stringContaining('metrics_estimated')],
        }),
        expect.objectContaining({ method: 'eq', args: ['source', 'binance_futures'] }),
        expect.objectContaining({ method: 'eq', args: ['source_trader_id', 'trader-1'] }),
        expect.objectContaining({ method: 'eq', args: ['season_id', '7D'] }),
      ])
    )
    expect(sourceCalls.some(({ method }) => method === 'or')).toBe(true)

    const text = collectText(mockImageTree)
    expect(text).toContain('3')
    expect(text).toContain('+12.5%')
    expect(text).not.toContain('Top 5%')
    expect(text.some((value) => /\/ .* traders/.test(value))).toBe(false)
  })

  it('renders rank and metrics as unknown when the view payload lacks proof', async () => {
    mockFrom
      .mockReturnValueOnce(
        query(
          {
            data: {
              handle: 'Partial Trader',
              source: 'binance_futures',
              source_trader_id: 'trader-1',
            },
            error: null,
          },
          []
        )
      )
      .mockReturnValueOnce(query({ data: candidate({ metrics_estimated: true }), error: null }, []))

    await GET({
      url: 'https://arenafi.org/api/share/rank-card?handle=Partial%20Trader&platform=binance_futures&window=7d',
    } as never)

    const text = collectText(mockImageTree)
    expect(text).toContain('Partial Trader')
    expect(text).toContain('--')
    expect(text).not.toContain('+12.5%')
    expect(text).not.toContain('92')
    expect(text).not.toContain('3')
  })

  it("does not bind another trader's verified rank to the resolved handle", async () => {
    mockFrom
      .mockReturnValueOnce(
        query(
          {
            data: {
              handle: 'Target Trader',
              source: 'binance_futures',
              source_trader_id: 'trader-1',
            },
            error: null,
          },
          []
        )
      )
      .mockReturnValueOnce(
        query({ data: candidate({ source_trader_id: 'other-trader' }), error: null }, [])
      )

    await GET({
      url: 'https://arenafi.org/api/share/rank-card?handle=Target%20Trader&platform=binance_futures&window=7d',
    } as never)

    const text = collectText(mockImageTree)
    expect(text).toContain('Target Trader')
    expect(text).toContain('--')
    expect(text).not.toContain('+12.5%')
    expect(text).not.toContain('3')
  })
})
