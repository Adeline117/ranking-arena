/**
 * Cron: check-data-freshness route tests
 * Tests auth, freshness reporting, alerting, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock @/lib/env so env.CRON_SECRET reads process.env.CRON_SECRET at call time
jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'CRON_SECRET') return process.env.CRON_SECRET
        return process.env[String(key)]
      },
    }
  ),
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
    return auth === 'Bearer test-secret'
  }),
  getSupabaseEnv: jest.fn(() => ({
    url: 'http://supabase.test',
    serviceKey: 'test-key',
  })),
}))

// （已删 @/lib/cron/fetchers 的死 mock —— 该模块在 D3+D4 退役删除，route 不再引用，
// jest 解析不到已删模块路径会导致整个 suite "Configuration error" 无法加载。）

jest.mock('@/lib/constants/exchanges', () => ({
  DEAD_BLOCKED_PLATFORMS: [],
  // route 用 SOURCES_WITH_DATA 作为待检平台列表（buildFreshnessReport 第一行
  // .filter 之）。不提供则 undefined.filter → loop 前抛 → GET catch → 500。
  // 给恰好 2 个平台以匹配下方 summary.fresh === 2 的断言。
  SOURCES_WITH_DATA: ['binance_futures', 'bybit'],
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendScraperAlert: jest.fn().mockResolvedValue({ sent: true }),
  sendRateLimitedAlert: jest.fn().mockResolvedValue({ sent: true }),
}))

jest.mock('@/lib/utils/logger', () => ({
  captureMessage: jest.fn(),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  apiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  captureError: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    dbError: jest.fn(),
  },
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({ success: jest.fn(), error: jest.fn(), timeout: jest.fn() })
    ),
  },
}))

jest.mock('@/lib/services/pipeline-self-heal', () => ({
  evaluateAndAlert: jest.fn().mockResolvedValue([]),
}))

import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(secret?: string): Request {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new Request('http://localhost:3000/api/cron/check-data-freshness', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/check-data-freshness', () => {
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

  it('returns fresh status for all platforms when data is recent', async () => {
    const recentTime = new Date().toISOString()

    mockFrom.mockImplementation(() => ({
      select: jest
        .fn()
        .mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            return {
              eq: jest.fn().mockResolvedValue({ count: 100, error: null }),
            }
          }
          return {
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: { updated_at: recentTime },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }),
    }))

    const res = await GET(createRequest('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.summary.fresh).toBe(2)
    expect(body.summary.stale).toBe(0)
    expect(body.summary.critical).toBe(0)
  })

  it('detects stale platforms (>8h old)', async () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString() // 10h ago
    const freshTime = new Date().toISOString()

    let callIdx = 0
    mockFrom.mockImplementation(() => ({
      select: jest
        .fn()
        .mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            return {
              eq: jest.fn().mockResolvedValue({ count: 50, error: null }),
            }
          }
          return {
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  single: jest.fn().mockImplementation(() => {
                    callIdx++
                    const time = callIdx === 1 ? staleTime : freshTime
                    return Promise.resolve({
                      data: { updated_at: time },
                      error: null,
                    })
                  }),
                }),
              }),
            }),
          }
        }),
    }))

    const res = await GET(createRequest('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.summary.stale).toBeGreaterThanOrEqual(1)
  })

  it('returns 500 when getSupabaseAdmin throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSupabaseAdmin } = require('@/lib/supabase/server')
    getSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('Supabase env vars missing')
    })

    // Since getSupabaseAdmin throws, the catch block should return 500
    const res = await GET(createRequest('test-secret'))
    expect(res.status).toBe(500)
  })
})
