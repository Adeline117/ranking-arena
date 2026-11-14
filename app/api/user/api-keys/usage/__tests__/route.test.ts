/** @jest-environment node */

type Result = Record<string, unknown>
let results: Result[] = []
const inFilters: unknown[][] = []

function query(result: Result) {
  const builder: Record<string, unknown> = {}
  for (const op of ['select', 'eq', 'gte', 'order']) builder[op] = () => builder
  builder.in = (...args: unknown[]) => {
    inFilters.push(args)
    return builder
  }
  builder.then = (resolve: (value: unknown) => void) => resolve(result)
  return builder
}
const mockSupabase = { from: jest.fn(() => query(results.shift() ?? { data: null, error: null })) }

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({ user: { id: 'user-1' }, supabase: mockSupabase, request }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const get = () => GET(new NextRequest('http://localhost/api/user/api-keys/usage?days=7') as never)
const today = new Date().toISOString().slice(0, 10)
const dbError = { message: 'relation "api_key_usage_daily" does not exist' }

describe('GET /api/user/api-keys/usage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    results = []
    inFilters.length = 0
  })

  it('returns an empty report for a user with no keys', async () => {
    results = [{ data: [], error: null }]

    await expect((await get()).json()).resolves.toEqual({
      data: { keys: [], daily: [], totals: {} },
    })
  })

  it('does not report a failed key lookup as "no keys"', async () => {
    results = [{ data: null, error: { message: 'db down' } }]

    expect((await get()).status).toBe(500)
  })

  it('never echoes the database error to the client', async () => {
    results = [
      { data: [{ id: 'k1', name: 'Bot' }], error: null },
      { data: null, error: dbError },
    ]

    const response = await get()

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('api_key_usage_daily')
  })

  it('merges today’s live count over the rollup and totals per key, for the caller’s keys only', async () => {
    results = [
      { data: [{ id: 'k1', name: 'Bot' }], error: null },
      {
        data: [
          { api_key_id: 'k1', date: '2026-11-01', request_count: 10 },
          { api_key_id: 'k1', date: today, request_count: 3 },
        ],
        error: null,
      },
      { data: [{ id: 'k1', request_count_today: 8 }], error: null },
    ]

    const body = await (await get()).json()

    expect(inFilters.every(([, ids]) => JSON.stringify(ids) === '["k1"]')).toBe(true)
    expect(body.data.totals).toEqual({ k1: 18 })
    expect(body.data.daily.find((d: { date: string }) => d.date === today).request_count).toBe(8)
  })

  it('still serves the rolled-up history when the live overlay fails', async () => {
    results = [
      { data: [{ id: 'k1', name: 'Bot' }], error: null },
      { data: [{ api_key_id: 'k1', date: '2026-11-01', request_count: 10 }], error: null },
      { data: null, error: { message: 'db down' } },
    ]

    const response = await get()

    expect(response.status).toBe(200)
    expect((await response.json()).data.totals).toEqual({ k1: 10 })
  })
})
