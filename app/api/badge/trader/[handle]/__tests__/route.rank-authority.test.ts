const mockFetch = jest.fn()

jest.mock('@/lib/rankings/publication-policy', () => ({
  isPublicRankingSourceAllowed: (source: unknown) => source === 'binance_futures',
  sanitizePublicRankingPayload: (
    { traders, period }: { traders: unknown; period: string },
    { expectedPeriod }: { expectedPeriod?: string }
  ) => ({
    traders: Array.isArray(traders)
      ? traders.filter(
          (row) =>
            typeof row === 'object' &&
            row !== null &&
            (row as Record<string, unknown>).source === 'binance_futures' &&
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

function urls() {
  return mockFetch.mock.calls.map(([url]) => String(url))
}

async function responseText(response: unknown): Promise<string> {
  const candidate = response as { text?: () => Promise<string>; _body?: unknown }
  if (typeof candidate.text === 'function') return candidate.text()
  return String(candidate._body ?? '')
}

import { GET } from '../route'

describe('trader badge public rank authority', () => {
  const originalFetch = global.fetch
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  beforeEach(() => {
    jest.clearAllMocks()
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

  it('renders only the exact sealed-view rank and bypasses CDN metric caching', async () => {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          { handle: 'Target Trader', source: 'binance_futures', source_trader_id: 'trader-1' },
        ])
      )
      .mockResolvedValueOnce(restResponse([publicRow()]))
      .mockResolvedValueOnce(restResponse([]))

    const response = await GET(
      { url: 'https://arenafi.org/api/badge/trader/Target.svg' } as never,
      { params: Promise.resolve({ handle: 'Target.svg' }) }
    )
    const svg = await responseText(response)
    const requests = urls()

    expect(svg).toContain('Target Trader')
    expect(svg).toContain('#3')
    expect(svg).toContain('92')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(requests.some((url) => url.includes('/leaderboard_ranks?'))).toBe(false)
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/trader_sources?'),
        expect.stringContaining('/public_ranked_leaderboard?'),
      ])
    )
    const viewRequest = requests.find((url) => url.includes('/public_ranked_leaderboard?'))
    expect(viewRequest).toContain('metrics_estimated')
    expect(viewRequest).toContain('source=eq.binance_futures')
    expect(viewRequest).toContain('source_trader_id=eq.trader-1')
    expect(viewRequest).toContain('season_id=eq.90D')
  })

  async function badgeFor(row: Record<string, unknown>) {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          { handle: 'Target Trader', source: 'binance_futures', source_trader_id: 'trader-1' },
        ])
      )
      .mockResolvedValueOnce(restResponse([row]))
      .mockResolvedValueOnce(restResponse([]))
    const response = await GET(
      { url: 'https://arenafi.org/api/badge/trader/Target.svg' } as never,
      { params: Promise.resolve({ handle: 'Target.svg' }) }
    )
    return responseText(response)
  }

  // Every "<" in the document must open or close a tag: a raw "<1" inside
  // <text> is not well-formed XML and browsers refuse to draw the image.
  const strayLessThan = (svg: string) => svg.replace(/<\/?[a-zA-Z][^<>]*>/g, '').includes('<')

  it('escapes a small score so the badge stays a well-formed SVG', async () => {
    const svg = await badgeFor(publicRow({ arena_score: 0.3 }))
    expect(svg).toContain('&lt;1</text>')
    expect(strayLessThan(svg)).toBe(false)
  })

  it('shows the rank but no score for an idle-window account', async () => {
    const svg = await badgeFor(publicRow({ arena_score: 0.01, idle_window: true }))
    expect(svg).toContain('#3')
    expect(svg).not.toContain('&lt;1')
    expect(svg).toMatch(/fill="#EDEDED">—<\/text>/)
    expect(strayLessThan(svg)).toBe(false)
    expect(urls().find((url) => url.includes('/public_ranked_leaderboard?'))).toContain(
      'idle_window'
    )
  })

  it('renders rank and score as unknown when the sealed row lacks proof', async () => {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          { handle: 'Target Trader', source: 'binance_futures', source_trader_id: 'trader-1' },
        ])
      )
      .mockResolvedValueOnce(restResponse([publicRow({ metrics_estimated: true })]))
      .mockResolvedValueOnce(restResponse([]))
      .mockResolvedValueOnce(restResponse([]))

    const response = await GET(
      { url: 'https://arenafi.org/api/badge/trader/Target.svg' } as never,
      { params: Promise.resolve({ handle: 'Target.svg' }) }
    )
    const svg = await responseText(response)

    expect(svg).toContain('Target Trader')
    expect(svg).toContain('>—</text>')
    expect(svg).not.toContain('#3')
    expect(svg).not.toContain('>92</text>')
    expect(urls().some((url) => url.includes('/leaderboard_ranks?'))).toBe(false)
  })

  it('does not bind a different view identity to the requested badge', async () => {
    mockFetch
      .mockResolvedValueOnce(
        restResponse([
          { handle: 'Target Trader', source: 'binance_futures', source_trader_id: 'trader-1' },
        ])
      )
      .mockResolvedValueOnce(restResponse([publicRow({ source_trader_id: 'other-trader' })]))
      .mockResolvedValueOnce(restResponse([]))
      .mockResolvedValueOnce(restResponse([]))

    const response = await GET(
      { url: 'https://arenafi.org/api/badge/trader/Target.svg' } as never,
      { params: Promise.resolve({ handle: 'Target.svg' }) }
    )
    const svg = await responseText(response)

    expect(svg).toContain('Target Trader')
    expect(svg).toContain('>—</text>')
    expect(svg).not.toContain('#3')
    expect(svg).not.toContain('>92</text>')
  })

  it('escapes ILIKE wildcard characters before resolving a badge identity', async () => {
    mockFetch.mockResolvedValueOnce(restResponse([])).mockResolvedValueOnce(restResponse([]))

    await GET({ url: 'https://arenafi.org/api/badge/trader/Target%2A.svg' } as never, {
      params: Promise.resolve({ handle: 'Target*.svg' }),
    })

    const identityRequest = urls().find((url) => url.includes('/trader_sources?'))
    expect(identityRequest).toContain('handle=ilike.Target%5C*')
    expect(identityRequest).not.toContain('handle=ilike.Target*')
  })
})
