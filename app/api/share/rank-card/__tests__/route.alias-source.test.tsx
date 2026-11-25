/**
 * Serving-only traders on alias sources (public `blofin`, serving slug
 * `blofin_futures`) have no trader_sources row. The card must find them through
 * arena_resolve_trader and read the public ranking by the alias.
 *
 * Real publication policy and real resolver code; only the database is faked.
 * The fake view honours the route's filters and returns only the columns the
 * route selected, as PostgREST would.
 */
import React from 'react'

let mockImageTree: React.ReactNode = null
const mockFrom = jest.fn()
const mockRpc = jest.fn()

jest.mock('next/og', () => ({
  ImageResponse: jest.fn().mockImplementation((element: React.ReactNode) => {
    mockImageTree = element
    return { element, status: 200 }
  }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))

jest.mock('@/lib/rankings/public-response-cache', () => ({
  publicRankingResponseCacheHeaders: () => ({}),
  publicRankingResponseRejectionHeaders: () => ({}),
  redirectToPublicRankingResponseCacheEpoch: () => null,
}))

import { GET } from '../route'

const TRADER_ID = '58572266235'

function boardRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    season_id: '7D',
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

/** trader_sources: this trader has no legacy row. */
function emptySourceQuery() {
  const chain: Record<string, jest.Mock> = {}
  for (const method of ['select', 'or', 'limit', 'eq']) chain[method] = jest.fn(() => chain)
  chain.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
  return chain
}

/** The public view: applies eq filters, then projects the selected columns. */
function viewQuery(rows: Record<string, unknown>[]) {
  let columns: string[] = []
  const filters: [string, unknown][] = []
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn((list: string) => {
    columns = list.split(',').map((column) => column.trim())
    return chain
  })
  chain.eq = jest.fn((column: string, value: unknown) => {
    filters.push([column, value])
    return chain
  })
  chain.maybeSingle = jest.fn(async () => {
    const match = rows.find((row) => filters.every(([column, value]) => row[column] === value))
    return {
      data: match
        ? Object.fromEntries(columns.filter((c) => c in match).map((c) => [c, match[c]]))
        : null,
      error: null,
    }
  })
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

async function requestCard(query: string, board: Record<string, unknown>[]) {
  mockFrom.mockImplementation((relation: string) =>
    relation === 'trader_sources' ? emptySourceQuery() : viewQuery(board)
  )
  const response = (await GET({
    url: `https://arenafi.org/api/share/rank-card?${query}`,
  } as never)) as { status: number }
  return { status: response.status, text: collectText(mockImageTree) }
}

describe('share rank card for serving-only traders on alias sources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockImageTree = null
  })

  it('renders the card when the request names the public alias', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow(), error: null })

    const { status, text } = await requestCard(`handle=${TRADER_ID}&platform=blofin&window=7d`, [
      boardRow(),
    ])

    expect(status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('arena_resolve_trader', {
      p_handle: TRADER_ID,
      p_source: 'blofin',
    })
    expect(text).toContain('Blofin Whale')
    expect(text).toContain('7') // rank
    expect(text).toContain('83') // arena score, rounded
    expect(text).toContain('+45.6%')
    expect(text).toContain('61%')
    expect(text).not.toContain('--')
  })

  it('uses the public name the resolver reports when the request names no platform', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow({ publicSource: 'blofin' }), error: null })

    const { status, text } = await requestCard(`handle=${TRADER_ID}&window=7d`, [boardRow()])

    expect(status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('arena_resolve_trader', {
      p_handle: TRADER_ID,
      p_source: null,
    })
    expect(text).toContain('+45.6%')
    expect(text).not.toContain('--')
  })

  it('does not guess an alias: a bare serving slug is not a public source', async () => {
    // Resolver does not report the public name and the request gave none, so
    // all that is known is the slug, which the public ranking does not publish.
    mockRpc.mockResolvedValue({ data: resolverRow(), error: null })

    const { status } = await requestCard(`handle=${TRADER_ID}&window=7d`, [boardRow()])

    expect(status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('resolves a nickname to the account id the board row carries', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow(), error: null })

    const { status, text } = await requestCard('handle=Blofin%20Whale&platform=blofin&window=7d', [
      boardRow(),
    ])

    expect(status).toBe(200)
    expect(text).toContain('+45.6%')
  })

  it('returns 404 for a trader that does not exist', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })

    const { status } = await requestCard('handle=nobody&platform=blofin&window=7d', [boardRow()])

    expect(status).toBe(404)
    expect(mockImageTree).toBeNull()
    expect(mockFrom).not.toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('returns 404 for a serving trader that is not on the public board', async () => {
    mockRpc.mockResolvedValue({ data: resolverRow(), error: null })

    const noRow = await requestCard(`handle=${TRADER_ID}&platform=blofin&window=7d`, [])
    expect(noRow.status).toBe(404)

    // A row that fails the public check is not a public identity either.
    const estimated = await requestCard(`handle=${TRADER_ID}&platform=blofin&window=7d`, [
      boardRow({ metrics_estimated: true }),
    ])
    expect(estimated.status).toBe(404)

    // Another period's row does not vouch for this one.
    const otherPeriod = await requestCard(`handle=${TRADER_ID}&platform=blofin&window=30d`, [
      boardRow(),
    ])
    expect(otherPeriod.status).toBe(404)
    expect(mockImageTree).toBeNull()
  })

  it('answers 503, not 404, when the resolver has no answer', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'upstream unavailable' } })

    const { status } = await requestCard(`handle=${TRADER_ID}&platform=blofin&window=7d`, [
      boardRow(),
    ])

    expect(status).toBe(503)
    expect(mockImageTree).toBeNull()
  })
})
