/**
 * Serving-only traders on alias sources (public `blofin`, serving slug
 * `blofin_futures`) have no trader_sources row. With a source in the request,
 * the OG card must find them through arena_resolve_trader and read the public
 * ranking by the alias.
 *
 * Real publication policy and real resolver code; only the database is faked.
 * The fake REST endpoint honours the route's filters and returns only the
 * columns the route selected, as PostgREST would.
 */
import React from 'react'

let mockImageTree: React.ReactNode = null
const mockFetch = jest.fn()
const mockRpc = jest.fn()

jest.mock('next/og', () => ({
  ImageResponse: jest.fn().mockImplementation((element: React.ReactNode) => {
    mockImageTree = element
    return { element }
  }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/lib/rankings/public-response-cache', () => ({
  publicRankingResponseRejectionHeaders: () => ({}),
  redirectToPublicRankingResponseCacheEpoch: () => null,
}))

import { GET } from '../route'

const TRADER_ID = '58572266235'

function boardRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    season_id: '90D',
    source: 'blofin',
    source_trader_id: TRADER_ID,
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
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function resolverRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'blofin_futures',
    fetchRegion: 'vps_sg',
    exchangeTraderId: TRADER_ID,
    nickname: 'Blofin Whale',
    avatarMirrorUrl: null,
    avatarOriginUrl: null,
    ...overrides,
  }
}

/** trader_sources is empty; the view filters by eq.* and projects `select`. */
function fakeRest(board: Record<string, unknown>[]) {
  return async (input: unknown) => {
    const url = new URL(String(input))
    const table = url.pathname.split('/').pop()
    let rows: Record<string, unknown>[] = []
    if (table === 'public_ranked_leaderboard') {
      const columns = (url.searchParams.get('select') ?? '').split(',')
      const filters = [...url.searchParams.entries()].filter(([, value]) => value.startsWith('eq.'))
      rows = board
        .filter((row) => filters.every(([column, value]) => String(row[column]) === value.slice(3)))
        .map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])))
    }
    return { ok: true, json: async () => rows } as Response
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

async function renderCard(query: string, board: Record<string, unknown>[]) {
  mockFetch.mockImplementation(fakeRest(board))
  await GET({ url: `https://arenafi.org/api/og/trader?${query}` } as never)
  return collectText(mockImageTree)
}

describe('trader OG card for serving-only traders on alias sources', () => {
  const originalFetch = global.fetch
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
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

  it('renders the published metrics when the request names the public alias', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow(), error: null })

    const text = await renderCard(`handle=${TRADER_ID}&source=blofin`, [boardRow()])

    expect(mockRpc).toHaveBeenCalledWith('arena_resolve_trader', {
      p_handle: TRADER_ID,
      p_source: 'blofin',
    })
    expect(text).toContain('Blofin Whale')
    expect(text.join('')).toContain('#7')
    expect(text).toContain('+45.6%')
    expect(text).toContain('83')
  })

  it('shows no metrics for a serving trader that is not on the public board', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow(), error: null })

    const text = await renderCard(`handle=${TRADER_ID}&source=blofin`, [])

    expect(text).toContain('Blofin Whale')
    expect(text).not.toContain('+45.6%')
    expect(text.join('')).not.toContain('#7')
  })

  it('binds nothing for a trader that does not exist', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })

    const text = await renderCard('handle=nobody&source=blofin', [boardRow()])

    expect(text).not.toContain('Blofin Whale')
    expect(text).not.toContain('+45.6%')
    const requests = mockFetch.mock.calls.map(([url]) => String(url))
    expect(requests.some((url) => url.includes('/public_ranked_leaderboard?'))).toBe(false)
  })

  it('does not ask the resolver to pick an account when the request names no source', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow({ publicSource: 'blofin' }), error: null })

    const text = await renderCard(`handle=${TRADER_ID}`, [boardRow()])

    expect(mockRpc).not.toHaveBeenCalled()
    expect(text).not.toContain('+45.6%')
  })
})
