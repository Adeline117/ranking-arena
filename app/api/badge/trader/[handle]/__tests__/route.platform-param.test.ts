/**
 * Badge lookups that do not go through trader_sources:
 *  - `?platform=` → arena_resolve_trader, public ranking read by the public
 *    source name (alias-aware);
 *  - no platform and no legacy row → the handle must identify exactly one
 *    account on the public ranking.
 *
 * Real publication policy and real resolver code; only the database is faked.
 * The fake REST endpoint applies the route's filters and limit and returns
 * only the columns the route selected, as PostgREST would.
 */
const mockFetch = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/lib/rankings/public-response-cache', () => ({
  publicRankingResponseRejectionHeaders: () => ({
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
  }),
  redirectToPublicRankingResponseCacheEpoch: () => null,
}))

import { GET } from '../route'

type Row = Record<string, unknown>

function boardRow(overrides: Row = {}): Row {
  return {
    season_id: '90D',
    source: 'blofin',
    source_trader_id: '58572266235',
    handle: 'Blofin Whale',
    avatar_url: null,
    rank: 7,
    arena_score: 83.4,
    roi: 45.6,
    pnl: 9876.5,
    win_rate: 61,
    max_drawdown: 9.5,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    idle_window: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function resolverRow(overrides: Row = {}) {
  return {
    source: 'blofin_futures',
    fetchRegion: 'vps_sg',
    exchangeTraderId: '58572266235',
    nickname: 'Blofin Whale',
    avatarMirrorUrl: null,
    avatarOriginUrl: null,
    publicSource: 'blofin',
    ...overrides,
  }
}

function matches(row: Row, column: string, filter: string): boolean {
  const value = row[column]
  if (filter.startsWith('eq.')) return String(value) === filter.slice(3)
  if (filter.startsWith('in.(')) return filter.slice(4, -1).split(',').includes(String(value))
  if (filter.startsWith('ilike.')) {
    // The route escapes wildcards, so the pattern is a literal, case-insensitive.
    const literal = filter.slice(6).replace(/\\(.)/g, '$1')
    return typeof value === 'string' && value.toLowerCase() === literal.toLowerCase()
  }
  throw new Error(`fake REST: unsupported filter ${column}=${filter}`)
}

function fakeRest(tables: { trader_sources?: Row[]; public_ranked_leaderboard?: Row[] }) {
  return async (input: unknown) => {
    const url = new URL(String(input))
    const table = url.pathname.split('/').pop() as keyof typeof tables
    const columns = (url.searchParams.get('select') ?? '').split(',')
    const limit = Number(url.searchParams.get('limit'))
    const filters = [...url.searchParams.entries()].filter(
      ([name]) => name !== 'select' && name !== 'limit'
    )
    const rows = (tables[table] ?? [])
      .filter((row) => filters.every(([column, filter]) => matches(row, column, filter)))
      .slice(0, limit)
      .map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])))
    return { ok: true, json: async () => rows } as Response
  }
}

// The jest Response polyfill has no text(); it keeps the body on _body.
async function responseText(response: unknown): Promise<string> {
  const candidate = response as { text?: () => Promise<string>; _body?: unknown }
  if (typeof candidate.text === 'function') return candidate.text()
  return String(candidate._body ?? '')
}

async function badge(pathAndQuery: string, handleParam: string) {
  const response = await GET(
    { url: `https://arenafi.org/api/badge/trader/${pathAndQuery}` } as never,
    {
      params: Promise.resolve({ handle: handleParam }),
    }
  )
  return { status: response.status, svg: await responseText(response), headers: response.headers }
}

function viewRequests() {
  return mockFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/public_ranked_leaderboard?'))
}

const NO_NUMBERS =
  /RANK<\/text>\s*<text[^>]*>—<\/text>\s*<text[^>]*>SCORE<\/text>\s*<text[^>]*>—<\/text>/

describe('trader badge without a trader_sources row', () => {
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

  describe('with ?platform=', () => {
    it('shows rank and score for an alias-source serving-only trader', async () => {
      mockRpc.mockResolvedValue({ data: resolverRow(), error: null })
      mockFetch.mockImplementation(fakeRest({ public_ranked_leaderboard: [boardRow()] }))

      const { status, svg, headers } = await badge(
        '58572266235.svg?platform=blofin',
        '58572266235.svg'
      )

      expect(status).toBe(200)
      expect(mockRpc).toHaveBeenCalledWith('arena_resolve_trader', {
        p_handle: '58572266235',
        p_source: 'blofin',
      })
      expect(svg).toContain('Blofin Whale')
      expect(svg).toContain('>#7</text>')
      expect(svg).toContain('>83</text>')
      expect(headers.get('Cache-Control')).toContain('no-store')
    })

    it('reads the board by the public name the resolver reports for a slug request', async () => {
      mockRpc.mockResolvedValue({ data: resolverRow(), error: null })
      mockFetch.mockImplementation(fakeRest({ public_ranked_leaderboard: [boardRow()] }))

      const { svg } = await badge('58572266235.svg?platform=blofin_futures', '58572266235.svg')

      expect(svg).toContain('>#7</text>')
      expect(viewRequests()[0]).toContain('source=eq.blofin&')
    })

    it('falls back to the requested name while the resolver reports no public name', async () => {
      mockRpc.mockResolvedValue({ data: resolverRow({ publicSource: undefined }), error: null })
      mockFetch.mockImplementation(fakeRest({ public_ranked_leaderboard: [boardRow()] }))

      const { svg } = await badge('58572266235.svg?platform=blofin', '58572266235.svg')

      expect(svg).toContain('>#7</text>')
    })

    it('shows no numbers for a serving trader that is not on the public board', async () => {
      mockRpc.mockResolvedValue({ data: resolverRow(), error: null })
      mockFetch.mockImplementation(
        fakeRest({ public_ranked_leaderboard: [boardRow({ metrics_estimated: true })] })
      )

      const { status, svg } = await badge('58572266235.svg?platform=blofin', '58572266235.svg')

      expect(status).toBe(200)
      expect(svg).toContain('Blofin Whale')
      expect(svg).toMatch(NO_NUMBERS)
    })

    it('does not show another source’s account that shares the handle', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null })
      mockFetch.mockImplementation(
        fakeRest({
          public_ranked_leaderboard: [boardRow({ source: 'binance_futures', handle: 'Shared' })],
        })
      )

      const { status, svg } = await badge('Shared.svg?platform=blofin', 'Shared.svg')

      expect(status).toBe(200)
      expect(svg).toMatch(NO_NUMBERS)
      expect(viewRequests()).toEqual([])
    })

    it('still serves a legacy trader on the named source', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null })
      mockFetch.mockImplementation(
        fakeRest({
          trader_sources: [
            { handle: 'Legacy Trader', source: 'binance_futures', source_trader_id: 'legacy-1' },
          ],
          public_ranked_leaderboard: [
            boardRow({ source: 'binance_futures', source_trader_id: 'legacy-1', rank: 12 }),
          ],
        })
      )

      const { svg } = await badge(
        'Legacy%20Trader.svg?platform=binance_futures',
        'Legacy Trader.svg'
      )

      expect(svg).toContain('Legacy Trader')
      expect(svg).toContain('>#12</text>')
    })

    it('answers 503, not a cacheable "no rank", when the resolver has no answer', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'upstream unavailable' } })
      mockFetch.mockImplementation(fakeRest({ public_ranked_leaderboard: [boardRow()] }))

      const { status, svg, headers } = await badge(
        '58572266235.svg?platform=blofin',
        '58572266235.svg'
      )

      expect(status).toBe(503)
      expect(svg).toContain('<svg')
      expect(svg).toMatch(NO_NUMBERS)
      expect(headers.get('Cache-Control')).toContain('no-store')
    })

    it('answers 503 when the public board cannot be read', async () => {
      mockRpc.mockResolvedValue({ data: resolverRow(), error: null })
      mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) } as Response)

      const { status, svg } = await badge('58572266235.svg?platform=blofin', '58572266235.svg')

      expect(status).toBe(503)
      expect(svg).toMatch(NO_NUMBERS)
    })
  })

  describe('without platform', () => {
    it('shows rank and score when exactly one public account has the id', async () => {
      mockFetch.mockImplementation(
        fakeRest({
          public_ranked_leaderboard: [
            boardRow({ season_id: '90D' }),
            boardRow({ season_id: '30D', rank: 9 }),
            boardRow({ season_id: '7D', rank: 11 }),
          ],
        })
      )

      const { status, svg } = await badge('58572266235.svg', '58572266235.svg')

      expect(status).toBe(200)
      expect(mockRpc).not.toHaveBeenCalled()
      expect(svg).toContain('Blofin Whale')
      expect(svg).toContain('>#7</text>') // longest period first
      expect(svg).toContain('>83</text>')
    })

    it('matches a nickname case-insensitively and uses the first publishable period', async () => {
      mockFetch.mockImplementation(
        fakeRest({
          public_ranked_leaderboard: [
            boardRow({ season_id: '90D', is_outlier: true }),
            boardRow({ season_id: '30D', rank: 9 }),
          ],
        })
      )

      const { svg } = await badge('blofin%20whale.svg', 'blofin%20whale.svg')

      expect(svg).toContain('>#9</text>')
    })

    it('shows no numbers when two sources carry the same handle', async () => {
      mockFetch.mockImplementation(
        fakeRest({
          public_ranked_leaderboard: [
            boardRow({ handle: 'Shared' }),
            boardRow({ handle: 'Shared', source: 'binance_futures', source_trader_id: 'b-1' }),
          ],
        })
      )

      const { status, svg } = await badge('Shared.svg', 'Shared.svg')

      expect(status).toBe(200)
      expect(svg).toMatch(NO_NUMBERS)
      expect(svg).not.toContain('>#7</text>')
    })

    it('shows no numbers when the handle is one account’s name and another’s id', async () => {
      mockFetch.mockImplementation(
        fakeRest({
          public_ranked_leaderboard: [
            boardRow({ handle: '777' }),
            boardRow({ source: 'binance_futures', source_trader_id: '777', handle: 'Other' }),
          ],
        })
      )

      const { svg } = await badge('777.svg', '777.svg')

      expect(svg).toMatch(NO_NUMBERS)
    })

    it('shows no numbers when the same handle is on different sources in different periods', async () => {
      mockFetch.mockImplementation(
        fakeRest({
          public_ranked_leaderboard: [
            boardRow({ handle: 'Shared', season_id: '90D' }),
            boardRow({
              handle: 'Shared',
              season_id: '30D',
              source: 'binance_futures',
              source_trader_id: 'b-1',
            }),
          ],
        })
      )

      const { svg } = await badge('Shared.svg', 'Shared.svg')

      expect(svg).toMatch(NO_NUMBERS)
    })

    it('shows the generic badge for a trader that does not exist', async () => {
      mockFetch.mockImplementation(fakeRest({ public_ranked_leaderboard: [boardRow()] }))

      const { status, svg } = await badge('nobody.svg', 'nobody.svg')

      expect(status).toBe(200)
      expect(svg).toContain('>Trader</text>')
      expect(svg).toMatch(NO_NUMBERS)
    })

    it('answers 503 when the uniqueness lookup cannot be read', async () => {
      mockFetch.mockImplementation(async (input: unknown) =>
        String(input).includes('/trader_sources?')
          ? ({ ok: true, json: async () => [] } as Response)
          : ({ ok: false, json: async () => ({}) } as Response)
      )

      const { status, svg } = await badge('58572266235.svg', '58572266235.svg')

      expect(status).toBe(503)
      expect(svg).toMatch(NO_NUMBERS)
    })
  })
})
