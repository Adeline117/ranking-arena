/**
 * Cron: fetch-details route tests
 * Tests auth, trader enrichment, error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock @/lib/env so env.CRON_SECRET reads process.env.CRON_SECRET at call time
jest.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, key) {
      if (key === 'CRON_SECRET') return process.env.CRON_SECRET
      return process.env[String(key)]
    },
  }),
}))


const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/cron/utils', () => ({
  isAuthorized: jest.fn((req: Request) => {
    const auth = req.headers.get('authorization')
    return auth === `Bearer test-secret`
  }),
  getSupabaseEnv: jest.fn(() => ({
    url: 'http://supabase.test',
    serviceKey: 'test-key',
  })),
  createSupabaseAdmin: jest.fn(() => mockSupabaseClient),
  logCronExecution: jest.fn(),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({ success: jest.fn(), error: jest.fn(), timeout: jest.fn() })
    ),
  },
}))

jest.mock('@/lib/services/schedule-manager', () => ({
  createScheduleManager: jest.fn(() => ({
    getTradersToRefresh: jest.fn().mockResolvedValue([]),
  })),
}))

jest.mock('@/lib/cron/fetchers/enrichment', () => ({
  fetchBinanceEquityCurve: jest.fn().mockResolvedValue([]),
  fetchBinancePositionHistory: jest.fn().mockResolvedValue([]),
  fetchBinanceStatsDetail: jest.fn().mockResolvedValue(null),
  fetchBybitEquityCurve: jest.fn().mockResolvedValue([]),
  fetchBybitPositionHistory: jest.fn().mockResolvedValue([]),
  fetchBybitStatsDetail: jest.fn().mockResolvedValue(null),
  fetchOkxStatsDetail: jest.fn().mockResolvedValue(null),
  fetchOkxCurrentPositions: jest.fn().mockResolvedValue([]),
  fetchHyperliquidPositionHistory: jest.fn().mockResolvedValue([]),
  fetchGmxPositionHistory: jest.fn().mockResolvedValue([]),
  upsertEquityCurve: jest.fn(),
  upsertPositionHistory: jest.fn(),
  upsertStatsDetail: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  apiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  dataLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

jest.mock('@/lib/cron/fetchers/shared', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}))

import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a chainable Supabase query mock */
function chainable(result: { data?: unknown; error?: unknown }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

function createRequest(secret?: string, params?: Record<string, string>): Request {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  const searchParams = new URLSearchParams(params || {})
  return new Request(`http://localhost:3000/api/cron/fetch-details?${searchParams}`, { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/fetch-details', () => {
  beforeAll(() => {
    process.env.CRON_SECRET = 'test-secret'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 401 when unauthorized', async () => {
    const res = await GET(createRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong secret', async () => {
    const res = await GET(createRequest('wrong'))
    expect(res.status).toBe(401)
  })

  it('processes traders successfully', async () => {
    const traders = [
      { platform: 'binance_futures', trader_key: 'trader1' },
      { platform: 'bybit', trader_key: 'trader2' },
    ]

    mockFrom.mockImplementation((table: string) => {
      if (table === 'traders') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    or: jest.fn().mockResolvedValue({ data: traders, error: null }),
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createRequest('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.summary.total).toBe(2)
    expect(body.summary.success).toBe(2)
  })

  it('returns 500 when database query throws', async () => {
    // Test that unhandled errors return 500
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSupabaseAdmin } = require('@/lib/supabase/server')
    getSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('Supabase env vars missing')
    })

    const res = await GET(createRequest('test-secret'))
    expect(res.status).toBe(500)
  })

  it('returns 500 when database query throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('DB connection lost')
    })

    const res = await GET(createRequest('test-secret'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('DB connection lost')
  })
})
