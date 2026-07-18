/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server'

const mockReleaseLock = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()
const mockQueryRanges: Array<{ table: string; from: number; to: number }> = []
const mockInFilters: Array<{ table: string; column: string; values: string[] }> = []
let mockFailureTable = ''
let mockLargeAudience = false

const mockRowByTable: Record<string, Record<string, unknown>> = {
  trader_follows: {
    user_id: 'user-1',
    trader_id: 'trader-1',
    source: 'bybit',
  },
  leaderboard_ranks: {
    source_trader_id: 'trader-1',
    source: 'bybit',
    rank: 1,
    roi: 12,
    pnl: 100,
  },
  rank_history: {
    trader_key: 'trader-1',
    platform: 'bybit',
    rank: 100,
  },
  trader_daily_snapshots: {
    trader_key: 'trader-1',
    platform: 'bybit',
    roi: 8,
    pnl: 70,
  },
}

function mockQueryFor(table: string) {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'order', 'eq']) {
    query[method] = jest.fn(() => query)
  }
  let filteredIds: string[] = []
  query.in = jest.fn((column: string, values: string[]) => {
    filteredIds = values
    mockInFilters.push({ table, column, values })
    return query
  })
  query.range = jest.fn(async (from: number, to: number) => {
    mockQueryRanges.push({ table, from, to })
    if (table === 'user_profiles') {
      if (filteredIds[0] === 'user-300') {
        return { data: null, error: { message: 'user_profiles page failed' } }
      }
      return {
        data: filteredIds.map((id) => ({ id, notify_trader_events: true })),
        error: null,
      }
    }
    if (mockLargeAudience && table === 'trader_follows') {
      if (from === 0) {
        return {
          data: Array.from({ length: 1000 }, (_, index) => ({
            user_id: `user-${index}`,
            trader_id: 'trader-1',
            source: 'bybit',
          })),
          error: null,
        }
      }
      return {
        data: [{ user_id: 'user-1000', trader_id: 'trader-1', source: 'bybit' }],
        error: null,
      }
    }
    if (table !== mockFailureTable) return { data: [mockRowByTable[table]], error: null }
    if (from === 0) {
      return {
        data: Array.from({ length: 1000 }, () => mockRowByTable[table]),
        error: null,
      }
    }
    return { data: null, error: { message: `${table} page failed` } }
  })
  return query
}

const mockFrom = jest.fn((table: string) => mockQueryFor(table))
const mockRpc = jest.fn(async () => ({ data: { rows: [] }, error: null }))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
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
  getPushNotificationService: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { GET } from '../route'

describe('broadcast trader event route pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryRanges.length = 0
    mockInFilters.length = 0
    mockFailureTable = ''
    mockLargeAudience = false
  })

  it.each([
    ['trader_follows', 'follows'],
    ['leaderboard_ranks', 'currentRanks'],
    ['rank_history', 'rankHistory'],
    ['trader_daily_snapshots', 'dailySnapshots'],
  ] as const)(
    'returns 500 and emits no notifications when a later %s page fails',
    async (table, dataset) => {
      mockFailureTable = table

      const response = await GET(
        new NextRequest('http://localhost/api/cron/broadcast-trader-events')
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'Internal error' })
      expect(mockQueryRanges.filter((range) => range.table === table)).toEqual([
        { table, from: 0, to: 999 },
        { table, from: 1000, to: 1999 },
      ])
      expect(mockFrom).not.toHaveBeenCalledWith('notifications')
      expect(mockPipelineSuccess).not.toHaveBeenCalled()
      expect(mockPipelineError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'BroadcastEventDataReadError',
          dataset,
        })
      )
      expect(mockReleaseLock).toHaveBeenCalledTimes(1)
    }
  )

  it('returns 500 and emits no notifications when a later preference id chunk fails', async () => {
    mockFailureTable = 'user_profiles'
    mockLargeAudience = true

    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal error' })
    expect(
      mockInFilters
        .filter((filter) => filter.table === 'user_profiles')
        .map((filter) => filter.values.length)
    ).toEqual([300, 300])
    expect(mockQueryRanges.filter((range) => range.table === 'user_profiles')).toEqual([
      { table: 'user_profiles', from: 0, to: 999 },
      { table: 'user_profiles', from: 0, to: 999 },
    ])
    expect(mockFrom).not.toHaveBeenCalledWith('notifications')
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BroadcastEventDataReadError',
        dataset: 'userPreferences',
      })
    )
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })
})
