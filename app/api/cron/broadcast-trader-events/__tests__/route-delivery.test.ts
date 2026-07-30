/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server'

const USER_ONE = '11111111-1111-4111-8111-111111111111'
const USER_TWO = '22222222-2222-4222-8222-222222222222'
const mockReleaseLock = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()
const mockPush = jest.fn(async () => [])
const mockSeenUpsert = jest.fn(async () => ({ error: null }))
const mockOrder: string[] = []
let mockPositionRows: Array<Record<string, unknown>> = []
let mockSeenRows: Array<{ symbol: string; side: string }> = []
let mockRankingRows = {
  follows: [
    { user_id: USER_ONE, trader_id: 'trader-1', source: 'bybit' },
    { user_id: USER_TWO, trader_id: 'trader-1', source: 'bybit' },
  ],
  currentRanks: [{ source_trader_id: 'trader-1', source: 'bybit', rank: 1, roi: 12, pnl: 100 }],
  rankHistory: [{ trader_key: 'trader-1', platform: 'bybit', rank: 100 }],
  dailySnapshots: [{ trader_key: 'trader-1', platform: 'bybit', roi: 12, pnl: 100 }],
}

const mockCreateBatch = jest.fn(
  async (
    _client: unknown,
    rows: Array<{
      userId: string
      title: string
      message: string
      link: string
      referenceId: string
    }>
  ) => {
    mockOrder.push('batch')
    const created = rows.slice(0, 1).map((row) => ({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      notificationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      ...row,
      createdAt: '2026-07-30T10:55:00+00:00',
    }))
    return {
      requestedCount: rows.length,
      createdCount: created.length,
      deduplicatedCount: rows.length - created.length,
      skippedCount: 0,
      created,
    }
  }
)

function seenQuery() {
  let equalityCount = 0
  const query: Record<string, jest.Mock> = {}
  query.select = jest.fn(() => query)
  query.eq = jest.fn(() => {
    equalityCount += 1
    return equalityCount === 2 ? Promise.resolve({ data: mockSeenRows, error: null }) : query
  })
  query.upsert = mockSeenUpsert
  return query
}

const mockFrom = jest.fn((table: string) => {
  if (table !== 'trader_position_seen') {
    throw new Error(`Unexpected table read: ${table}`)
  }
  return seenQuery()
})
const mockRpc = jest.fn(async (name: string) => {
  if (name !== 'arena_records_page') throw new Error(`Unexpected RPC: ${name}`)
  return { data: { rows: mockPositionRows }, error: null }
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))

jest.mock('@/lib/data/ranking-notifications', () => ({
  createRankingNotificationsBatch: (...args: unknown[]) => mockCreateBatch(...args),
}))

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: () => true,
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: jest.fn(async () => mockReleaseLock),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(async () => ({
      success: mockPipelineSuccess,
      error: mockPipelineError,
    })),
  },
}))

jest.mock('@/lib/services/push-notification', () => ({
  getPushNotificationService: () => ({
    sendToUser: (...args: unknown[]) => {
      mockOrder.push('push')
      return mockPush(...args)
    },
  }),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: jest.fn(async () => ({
    value: mockRankingRows,
    publication: {},
    publicationIdentity: 'sealed-publication',
  })),
}))

jest.mock('../event-data', () => ({
  loadBroadcastEventRows: jest.fn(),
  loadBroadcastEventPreferences: jest.fn(async (userIds: string[]) =>
    userIds.map((id) => ({ id, notify_trader_events: true }))
  ),
}))

import { GET } from '../route'

describe('broadcast trader event durable delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockOrder.length = 0
    mockPositionRows = []
    mockSeenRows = []
    mockRankingRows = {
      follows: [
        { user_id: USER_ONE, trader_id: 'trader-1', source: 'bybit' },
        { user_id: USER_TWO, trader_id: 'trader-1', source: 'bybit' },
      ],
      currentRanks: [{ source_trader_id: 'trader-1', source: 'bybit', rank: 1, roi: 12, pnl: 100 }],
      rankHistory: [{ trader_key: 'trader-1', platform: 'bybit', rank: 100 }],
      dailySnapshots: [{ trader_key: 'trader-1', platform: 'bybit', roi: 12, pnl: 100 }],
    }
  })

  it('persists all logical rows but pushes only the CREATED acknowledgement set', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      events: 1,
      notified: 1,
      deduplicated: 1,
      skipped: 0,
    })
    expect(mockCreateBatch).toHaveBeenCalledTimes(1)
    expect(mockCreateBatch.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        userId: USER_ONE,
        referenceId: expect.stringContaining(':metric:'),
      }),
      expect.objectContaining({
        userId: USER_TWO,
        referenceId: expect.stringContaining(':metric:'),
      }),
    ])
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith(
      USER_ONE,
      expect.objectContaining({
        data: expect.objectContaining({ type: 'ranking_change' }),
      })
    )
    expect(mockFrom).not.toHaveBeenCalledWith('notifications')
    expect(mockPipelineSuccess).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ requested: 2, deduplicated: 1 })
    )
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })

  it('persists real new-position seen-state only after durable creation and push', async () => {
    mockRankingRows = {
      follows: [{ user_id: USER_ONE, trader_id: 'trader-1', source: 'bybit' }],
      currentRanks: [
        { source_trader_id: 'trader-1', source: 'bybit', rank: 10, roi: 12, pnl: 100 },
      ],
      rankHistory: [{ trader_key: 'trader-1', platform: 'bybit', rank: 10 }],
      dailySnapshots: [{ trader_key: 'trader-1', platform: 'bybit', roi: 12, pnl: 100 }],
    }
    mockPositionRows = [
      { symbol: 'BTCUSDT', side: 'long' },
      { symbol: 'ETHUSDT', side: 'short' },
    ]
    mockSeenRows = [{ symbol: 'BTCUSDT', side: 'long' }]
    mockSeenUpsert.mockImplementationOnce(async () => {
      mockOrder.push('seen')
      return { error: null }
    })

    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    expect(response.status).toBe(200)
    expect(mockOrder).toEqual(['batch', 'push', 'seen'])
    expect(mockCreateBatch.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        userId: USER_ONE,
        message: 'trader-1 opened ETHUSDT short',
        referenceId: expect.stringContaining(':position:'),
      }),
    ])
    expect(mockSeenUpsert).toHaveBeenCalledWith(
      [{ trader_id: 'trader-1', source: 'bybit', symbol: 'ETHUSDT', side: 'short' }],
      { onConflict: 'trader_id,source,symbol,side', ignoreDuplicates: true }
    )
  })

  it('leaves new-position seen-state untouched when durable creation fails', async () => {
    mockRankingRows = {
      follows: [{ user_id: USER_ONE, trader_id: 'trader-1', source: 'bybit' }],
      currentRanks: [
        { source_trader_id: 'trader-1', source: 'bybit', rank: 10, roi: 12, pnl: 100 },
      ],
      rankHistory: [{ trader_key: 'trader-1', platform: 'bybit', rank: 10 }],
      dailySnapshots: [{ trader_key: 'trader-1', platform: 'bybit', roi: 12, pnl: 100 }],
    }
    mockPositionRows = [{ symbol: 'ETHUSDT', side: 'short' }]
    mockSeenRows = [{ symbol: 'BTCUSDT', side: 'long' }]
    mockCreateBatch.mockRejectedValueOnce(new Error('authority unavailable'))

    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal error' })
    expect(mockSeenUpsert).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledWith(expect.any(Error))
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })
})
