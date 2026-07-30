import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockReadSealedRankIdentities = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: 'user-1' },
        supabase: { from: mockFrom, rpc: mockRpc },
        request,
      }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/rankings/read-sealed-rank-identities', () => ({
  readSealedRankIdentities: (...args: unknown[]) => mockReadSealedRankIdentities(...args),
}))

jest.mock('@/lib/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { createLogger: () => logger, logger }
})

function watchlistQuery(result: { data: unknown[] | null; error: unknown }) {
  const builder: Record<string, jest.Mock> = {}
  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.order = jest.fn(() => builder)
  builder.limit = jest.fn().mockResolvedValue(result)
  return builder
}

import { DELETE, GET, POST } from '../route'

describe('GET /api/watchlist availability', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockReset()
    mockGetSupabaseAdmin.mockReturnValue({ from: jest.fn(), rpc: jest.fn() })
    mockReadSealedRankIdentities.mockResolvedValue(null)
  })

  it('keeps a real empty watchlist as a successful empty result', async () => {
    mockFrom.mockReturnValue(watchlistQuery({ data: [], error: null }))

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ watchlist: [] })
  })

  it.each([
    { code: 'PGRST205', message: 'Could not find the table' },
    { code: '42P01', message: 'relation does not exist' },
  ])('returns 503 instead of a fabricated empty list for $code', async (databaseError) => {
    mockFrom.mockReturnValue(watchlistQuery({ data: null, error: databaseError }))

    const response = await GET({} as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Watchlist is temporarily unavailable',
      },
    })
  })

  it('keeps unrelated database failures distinct from a real empty list', async () => {
    mockFrom.mockReturnValue(
      watchlistQuery({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('enriches only the exact watchlist identity from one sealed generation', async () => {
    mockFrom.mockReturnValue(
      watchlistQuery({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'shared-id',
            handle: 'watchlisted',
            created_at: '2026-07-29T00:00:00Z',
          },
        ],
        error: null,
      })
    )
    mockReadSealedRankIdentities.mockResolvedValue({
      value: [
        {
          source: 'binance_futures',
          source_trader_id: 'shared-id',
          handle: 'rank-handle',
          avatar_url: 'avatar.png',
          roi: 10,
          pnl: 20,
          win_rate: 30,
          followers: 40,
          arena_score: 50,
          rank: 60,
        },
      ],
      publication: { state: 'sealed' },
      publicationIdentity: 'proof',
    })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    expect(mockReadSealedRankIdentities).toHaveBeenCalledWith(mockGetSupabaseAdmin(), '90D', [
      { source: 'binance_futures', sourceTraderId: 'shared-id' },
    ])
    await expect(response.json()).resolves.toEqual({
      watchlist: [
        expect.objectContaining({
          source: 'binance_futures',
          source_trader_id: 'shared-id',
          roi: 10,
          pnl: 20,
          win_rate: 30,
          arena_score: 50,
          rank: 60,
          avatar_url: 'avatar.png',
        }),
      ],
    })
  })

  it('fails closed instead of returning unsealed partial rank enrichment', async () => {
    mockFrom.mockReturnValue(
      watchlistQuery({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'trader-1',
            handle: 'trader',
            created_at: '2026-07-29T00:00:00Z',
          },
        ],
        error: null,
      })
    )
    mockReadSealedRankIdentities.mockRejectedValue(new Error('proof unavailable'))

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    })
  })
})

const USER_ID = 'user-1'
const SOURCE = 'bybit'
const TRADER_ID = 'leader-1'

function request(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

function item(
  sourceTraderId: string,
  overrides: Partial<{
    source: string
    handle: string | null
    created_at: string
  }> = {}
) {
  return {
    source: overrides.source ?? SOURCE,
    source_trader_id: sourceTraderId,
    handle: overrides.handle ?? 'Leader',
    created_at: overrides.created_at ?? '2026-07-29T00:00:00+00:00',
  }
}

function mutationAck(
  status: 'added' | 'already_present' | 'removed' | 'not_present',
  watchlist = status === 'removed' || status === 'not_present' ? [] : [item(TRADER_ID)],
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    user_id: USER_ID,
    source: SOURCE,
    source_trader_id: TRADER_ID,
    current_count: watchlist.length,
    limit: 200,
    watchlist,
    ...overrides,
  }
}

describe('watchlist atomic mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockImplementation((table: string) => {
      throw new Error(`Unexpected direct table access: ${table}`)
    })
    mockRpc.mockResolvedValue({ data: mutationAck('added'), error: null })
  })

  it('adds through the atomic authority and consumes its same-transaction list', async () => {
    const response = await POST(
      request({ source: SOURCE, source_trader_id: TRADER_ID, handle: 'Leader' })
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('mutate_trader_watchlist_atomic', {
      p_source: SOURCE,
      p_source_trader_id: TRADER_ID,
      p_handle: 'Leader',
      p_action: 'add',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ watchlist: [item(TRADER_ID)] })
  })

  it('accepts an idempotent add without running a direct count or reread', async () => {
    mockRpc.mockResolvedValue({ data: mutationAck('already_present'), error: null })

    const response = await POST(request({ source: SOURCE, source_trader_id: TRADER_ID }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'mutate_trader_watchlist_atomic',
      expect.objectContaining({ p_handle: null, p_action: 'add' })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('removes only the exact composite identity and consumes the returned list', async () => {
    const remaining = [item('same-id', { source: 'binance_futures' })]
    mockRpc.mockResolvedValue({
      data: mutationAck('removed', remaining, {
        current_count: 1,
      }),
      error: null,
    })

    const response = await DELETE(request({ source: SOURCE, source_trader_id: TRADER_ID }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('mutate_trader_watchlist_atomic', {
      p_source: SOURCE,
      p_source_trader_id: TRADER_ID,
      p_handle: null,
      p_action: 'remove',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ watchlist: remaining })
  })

  it('returns the authoritative hard limit without attempting a fallback write', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'limit_reached', current_count: 200, limit: 200 },
      error: null,
    })

    const response = await POST(request({ source: SOURCE, source_trader_id: TRADER_ID }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { message: 'Watchlist full (max 200)' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects an unavailable source+trader composite without persisting a ghost row', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_unavailable' }, error: null })

    const response = await POST(request({ source: SOURCE, source_trader_id: 'ghost' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { message: 'Trader identity is unavailable' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects an inactive account without a direct mutation fallback', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'account_inactive' }, error: null })

    const response = await POST(request({ source: SOURCE, source_trader_id: TRADER_ID }))

    expect(response.status).toBe(403)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['missing RPC', { code: 'PGRST202', message: 'Could not find the function' }],
    ['missing table', { code: '42P01', message: 'relation does not exist' }],
  ])('returns 503 on a %s instead of fabricating an empty list', async (_label, error) => {
    mockRpc.mockResolvedValue({ data: null, error })

    const response = await POST(request({ source: SOURCE, source_trader_id: TRADER_ID }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['database failure', { data: null, error: { code: 'XX000', message: 'failed' } }],
    ['null ACK', { data: null, error: null }],
    ['unknown ACK', { data: { status: 'ok' }, error: null }],
    [
      'wrong owner',
      { data: mutationAck('added', [item(TRADER_ID)], { user_id: 'other-user' }), error: null },
    ],
    [
      'wrong source',
      { data: mutationAck('added', [item(TRADER_ID)], { source: 'okx' }), error: null },
    ],
    [
      'wrong trader id',
      {
        data: mutationAck('added', [item(TRADER_ID)], { source_trader_id: 'other-trader' }),
        error: null,
      },
    ],
    [
      'snapshot count mismatch',
      { data: mutationAck('added', [item(TRADER_ID)], { current_count: 2 }), error: null },
    ],
    [
      'wrong action status',
      { data: mutationAck('removed', [], { current_count: 0 }), error: null },
    ],
    [
      'unexpected ACK field',
      { data: mutationAck('added', [item(TRADER_ID)], { legacy: true }), error: null },
    ],
  ])('fails closed on a %s without a table fallback', async (_label, rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await POST(request({ source: SOURCE, source_trader_id: TRADER_ID }))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    { source: ' Bybit', source_trader_id: TRADER_ID },
    { source: 'Bybit', source_trader_id: TRADER_ID },
    { source: SOURCE, source_trader_id: ` ${TRADER_ID}` },
    { source: SOURCE, source_trader_id: 'bad\u0000id' },
    { source: SOURCE, source_trader_id: TRADER_ID, handle: 42 },
    { source: SOURCE, source_trader_id: TRADER_ID, handle: ' padded ' },
  ])('rejects a malformed exact identity before the authority: %p', async (body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not allow DELETE to smuggle an add-only handle', async () => {
    const response = await DELETE(
      request({ source: SOURCE, source_trader_id: TRADER_ID, handle: 'forged' })
    )

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('contains no direct count, write, or post-write read fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/watchlist/route.ts'), 'utf8')
    const post = source.slice(
      source.indexOf('export const POST'),
      source.indexOf('export const DELETE')
    )
    const remove = source.slice(source.indexOf('export const DELETE'))

    for (const mutation of [post, remove]) {
      expect(mutation).toContain(".rpc('mutate_trader_watchlist_atomic'")
      expect(mutation).not.toContain(".from('trader_watchlist')")
      expect(mutation).not.toContain("count: 'exact'")
      expect(mutation).not.toContain('.upsert(')
      expect(mutation).not.toContain('.insert(')
      expect(mutation).not.toContain('.delete(')
      expect(mutation).not.toContain(".select('source, source_trader_id")
    }
  })
})
