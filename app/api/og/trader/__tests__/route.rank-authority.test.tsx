import React from 'react'

let mockImageTree: React.ReactNode = null
let mockImageOptions: Record<string, unknown> | undefined
const mockFetch = jest.fn()

jest.mock('next/og', () => ({
  ImageResponse: jest
    .fn()
    .mockImplementation((element: React.ReactNode, options?: Record<string, unknown>) => {
      mockImageTree = element
      mockImageOptions = options
      return { element, options }
    }),
}))

jest.mock('@/lib/rankings/publication-policy', () => ({
  isPublicRankingSourceAllowed: (source: unknown) =>
    source === 'binance_futures' || source === 'okx_futures',
  sanitizePublicRankingPayload: (
    { traders, period }: { traders: unknown; period: string },
    { expectedPeriod }: { expectedPeriod?: string }
  ) => ({
    traders: Array.isArray(traders)
      ? traders.filter(
          (row) =>
            typeof row === 'object' &&
            row !== null &&
            ((row as Record<string, unknown>).source === 'binance_futures' ||
              (row as Record<string, unknown>).source === 'okx_futures') &&
            (row as Record<string, unknown>).season_id === period &&
            expectedPeriod === period &&
            (row as Record<string, unknown>).score_completeness === 'full' &&
            (row as Record<string, unknown>).metrics_estimated === false &&
            (row as Record<string, unknown>).is_outlier === false
        )
      : [],
  }),
}))

jest.mock('@/lib/rankings/public-response-cache', () => ({
  publicRankingResponseRejectionHeaders: () => ({
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
  }),
  redirectToPublicRankingResponseCacheEpoch: () => null,
}))

function restResponse(rows: unknown[]) {
  return {
    ok: true,
    json: async () => rows,
  } as Response
}

function publicRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    season_id: '90D',
    handle: 'Target Trader',
    avatar_url: null,
    rank: 3,
    arena_score: 91.5,
    roi: 12.5,
    pnl: 1000,
    win_rate: 65,
    max_drawdown: 20,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
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

function urls() {
  return mockFetch.mock.calls.map(([url]) => String(url))
}

import { GET } from '../route'

describe('trader OG public rank authority', () => {
  const originalFetch = global.fetch
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
    mockImageOptions = undefined
    global.fetch = mockFetch as typeof fetch
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  })

  afterAll(() => {
    global.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey
  })

  it('renders metrics only from the exact sealed view row and disables CDN metric caching', async () => {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          {
            handle: 'Target Trader',
            avatar_url: null,
            source: 'binance_futures',
            source_trader_id: 'trader-1',
          },
        ])
      )
      .mockResolvedValueOnce(restResponse([publicRow()]))

    await GET({ url: 'https://arenafi.org/api/og/trader?handle=Target' } as never)
    const text = collectText(mockImageTree)
    const rendered = text.join('')
    const requests = urls()
    const headers = mockImageOptions?.headers as Record<string, string>

    expect(text).toContain('Target Trader')
    expect(rendered).toContain('#3')
    expect(text).toContain('+12.5%')
    expect(text).toContain('92')
    expect(headers['Cache-Control']).toContain('no-store')
    expect(headers['CDN-Cache-Control']).toBe('no-store')
    expect(requests.some((url) => url.includes('/leaderboard_ranks?'))).toBe(false)
    const viewRequest = requests.find((url) => url.includes('/public_ranked_leaderboard?'))
    expect(viewRequest).toContain('metrics_estimated')
    expect(viewRequest).toContain('source=eq.binance_futures')
    expect(viewRequest).toContain('source_trader_id=eq.trader-1')
    expect(viewRequest).toContain('season_id=eq.90D')
  })

  it('keeps identity but renders metrics as unknown when the view row is not publishable', async () => {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          {
            handle: 'Target Trader',
            avatar_url: null,
            source: 'binance_futures',
            source_trader_id: 'trader-1',
          },
        ])
      )
      .mockResolvedValueOnce(restResponse([publicRow({ metrics_estimated: true })]))
      .mockResolvedValueOnce(restResponse([]))
      .mockResolvedValueOnce(restResponse([]))

    await GET({ url: 'https://arenafi.org/api/og/trader?handle=Target' } as never)
    const text = collectText(mockImageTree)
    const rendered = text.join('')

    expect(text).toContain('Target Trader')
    expect(text).toContain('--')
    expect(rendered).not.toContain('#3')
    expect(text).not.toContain('+12.5%')
    expect(text).not.toContain('92')
    expect(urls().some((url) => url.includes('/leaderboard_ranks?'))).toBe(false)
  })

  it('binds a source hint to both identity resolution and the sealed metric row', async () => {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          {
            handle: 'Target Trader',
            avatar_url: null,
            source: 'okx_futures',
            source_trader_id: 'okx-trader',
          },
        ])
      )
      // A malformed/proxy-mismatched row must not let a Binance metric display
      // under an OKX source badge.
      .mockResolvedValueOnce(restResponse([publicRow({ source: 'binance_futures' })]))
      .mockResolvedValueOnce(restResponse([]))
      .mockResolvedValueOnce(restResponse([]))

    await GET({
      url: 'https://arenafi.org/api/og/trader?handle=Target&source=okx_futures',
    } as never)
    const text = collectText(mockImageTree)
    const rendered = text.join('')
    const requests = urls()
    const viewRequest = requests.find((url) => url.includes('/public_ranked_leaderboard?'))
    const identityRequest = requests.find((url) => url.includes('/trader_sources?'))

    expect(text).toContain('OKX')
    expect(text).not.toContain('Binance')
    expect(rendered).not.toContain('#3')
    expect(text).not.toContain('+12.5%')
    expect(identityRequest).toContain('source=eq.okx_futures')
    expect(viewRequest).toContain('source=eq.okx_futures')
    expect(viewRequest).toContain('source_trader_id=eq.okx-trader')
  })

  it('escapes ILIKE wildcard characters before resolving an OG identity', async () => {
    mockFetch.mockResolvedValueOnce(restResponse([])).mockResolvedValueOnce(restResponse([]))

    await GET({ url: 'https://arenafi.org/api/og/trader?handle=Target*' } as never)

    const identityRequest = urls().find((url) => url.includes('/trader_sources?'))
    expect(identityRequest).toContain('handle=ilike.Target%5C*')
    expect(identityRequest).not.toContain('handle=ilike.Target*')
  })
})
