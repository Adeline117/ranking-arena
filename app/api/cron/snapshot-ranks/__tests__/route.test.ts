/** @jest-environment node */

let mockFetchError: { message: string } | null = null
let mockUpsertError: { message: string } | null = null
let mockCleanupError: { message: string } | null = null

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    try {
      const result = await handler(request, {})
      return Response.json({ ok: true, ...result })
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 })
    }
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
}))

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'public_ranked_leaderboard') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          order: () => chain,
          limit: async () =>
            mockFetchError
              ? { data: null, error: mockFetchError }
              : {
                  data: [{ source: 'bybit', source_trader_id: 't1', rank: 1, arena_score: 90 }],
                  error: null,
                },
        }
        return chain
      }
      return {
        upsert: async () => ({ error: mockUpsertError }),
        delete: () => ({ lt: async () => ({ error: mockCleanupError }) }),
      }
    },
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const run = () => GET(new NextRequest('http://localhost/api/cron/snapshot-ranks'))

describe('snapshot-ranks', () => {
  beforeEach(() => {
    mockFetchError = null
    mockUpsertError = null
    mockCleanupError = null
  })

  it('succeeds when every query succeeds', async () => {
    const response = await run()
    expect(response.status).toBe(200)
    expect((await response.json()).count).toBe(3)
  })

  it('fails the run when a leaderboard fetch errors', async () => {
    mockFetchError = { message: 'relation does not exist' }
    const response = await run()
    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain('fetch: relation does not exist')
  })

  it('fails the run when an upsert errors', async () => {
    mockUpsertError = { message: 'permission denied' }
    expect((await run()).status).toBe(500)
  })

  it('fails the run when retention cleanup errors', async () => {
    mockCleanupError = { message: 'timeout' }
    expect((await run()).status).toBe(500)
  })
})
