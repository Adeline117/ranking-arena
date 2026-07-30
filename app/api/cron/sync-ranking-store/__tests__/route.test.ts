/**
 * @jest-environment node
 */

const mockSyncSortedSet = jest.fn()
const mockSupabase = { rpc: jest.fn() }

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, { supabase: mockSupabase })
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    },
}))

jest.mock('@/lib/realtime/ranking-store', () => ({
  syncSortedSetFromLeaderboard: (...args: unknown[]) => mockSyncSortedSet(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/sync-ranking-store')
}

describe('GET /api/cron/sync-ranking-store', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSyncSortedSet.mockResolvedValueOnce(10).mockResolvedValueOnce(20).mockResolvedValueOnce(30)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('syncs every season under one run-wide deadline', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      count: 60,
      synced: { '7D': 10, '30D': 20, '90D': 30 },
    })
    expect(timeoutSpy).toHaveBeenCalledWith(45_000)
    expect(mockSyncSortedSet).toHaveBeenCalledTimes(3)
    const signals = mockSyncSortedSet.mock.calls.map((call) => call[2].signal)
    expect(signals).toEqual([
      expect.any(AbortSignal),
      expect.any(AbortSignal),
      expect.any(AbortSignal),
    ])
    expect(new Set(signals).size).toBe(1)
  })

  it('fails the cron and stops later seasons when a rebuild fails', async () => {
    mockSyncSortedSet
      .mockReset()
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('Redis transaction failed'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('Redis transaction failed')
    expect(mockSyncSortedSet).toHaveBeenCalledTimes(2)
  })

  it('does not start a season when the run-wide deadline is exhausted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('ranking sync deadline'))
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockSyncSortedSet).not.toHaveBeenCalled()
  })
})
