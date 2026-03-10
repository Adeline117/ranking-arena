/**
 * Cron: check-data-freshness route tests
 * Tests auth, freshness reporting, alerting, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
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

jest.mock('@/lib/cron/fetchers', () => ({
  getSupportedInlinePlatforms: jest.fn(() => ['binance_futures', 'bybit']),
}))

jest.mock('@/lib/constants/exchanges', () => ({
  DEAD_BLOCKED_PLATFORMS: [],
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendScraperAlert: jest.fn().mockResolvedValue({ sent: true }),
}))

jest.mock('@/lib/utils/logger', () => ({
  captureMessage: jest.fn(),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
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
      select: jest.fn().mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
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
                  data: { captured_at: recentTime },
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
      select: jest.fn().mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
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
                    data: { captured_at: time },
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

  it('returns 500 when buildFreshnessReport throws', async () => {
    // Force getSupabaseEnv to return empty to cause an error
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSupabaseEnv } = require('@/lib/cron/utils')
    getSupabaseEnv.mockReturnValueOnce({ url: '', serviceKey: '' })

    // Since buildFreshnessReport will throw, the catch block should return 500
    const res = await GET(createRequest('test-secret'))
    expect(res.status).toBe(500)
  })
})
