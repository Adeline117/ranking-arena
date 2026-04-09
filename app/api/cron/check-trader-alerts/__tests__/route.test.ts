/**
 * Cron: check-trader-alerts route tests
 * Tests auth, alert checking, notification sending, and error handling.
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

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn().mockResolvedValue({
      success: jest.fn().mockResolvedValue(undefined),
      error: jest.fn().mockResolvedValue(undefined),
      timeout: jest.fn().mockResolvedValue(undefined),
    }),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/services/push-notification', () => ({
  getPushNotificationService: jest.fn(() => ({
    sendToUser: jest.fn().mockResolvedValue(undefined),
  })),
}))

jest.mock('@/lib/services/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  buildTraderAlertEmail: jest.fn().mockReturnValue('<html>alert</html>'),
}))

import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(method: string, secret?: string): Request {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new Request('http://localhost:3000/api/cron/check-trader-alerts', {
    method,
    headers,
  })
}

/** Build chainable mock */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('check-trader-alerts cron', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------
  // Route is now GET-only (Vercel cron posts via GET with Bearer auth)

  it('returns 401 when CRON_SECRET is missing', async () => {
    const res = await GET(createRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when secret does not match', async () => {
    const res = await GET(createRequest('GET', 'wrong'))
    expect(res.status).toBe(401)
  })

  // ---- No active alerts ----------------------------------------------------

  it('handles no active alerts', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_alerts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createRequest('GET', CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.alertsChecked).toBe(0)
    expect(body.alertsSent).toBe(0)
  })

  // ---- Successful alert processing ----------------------------------------

  it('processes alerts and sends notifications for significant changes', async () => {
    const alerts = [
      {
        id: 'alert1',
        user_id: 'user1',
        trader_id: 'trader1',
        source: 'binance_futures',
        alert_roi_change: true,
        roi_change_threshold: 5,
        alert_drawdown: false,
        drawdown_threshold: 20,
        alert_pnl_change: false,
        pnl_change_threshold: 1000,
        alert_score_change: false,
        score_change_threshold: 5,
        alert_rank_change: false,
        rank_change_threshold: 10,
        alert_new_position: false,
        alert_price_above: false,
        price_above_value: null,
        alert_price_below: false,
        price_below_value: null,
        price_symbol: null,
        one_time: false,
        enabled: true,
      },
    ]

    // Route now queries leaderboard_ranks for current data
    const leaderboardData = [
      { source_trader_id: 'trader1', source: 'binance_futures', roi: 60, pnl: 10000, max_drawdown: -10, win_rate: 0.6, arena_score: 85, season_id: '90D' },
    ]

    // Route now queries trader_daily_snapshots for yesterday's data
    const dailySnapshots = [
      { trader_key: 'trader1', platform: 'binance_futures', roi: 40, pnl: 8000, max_drawdown: -8, date: new Date(Date.now() - 86400000).toISOString().split('T')[0] },
    ]

    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_alerts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({ data: alerts, error: null }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ error: null }),
          }),
        }
      }
      if (table === 'leaderboard_ranks') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: leaderboardData, error: null }),
            }),
          }),
        }
      }
      if (table === 'trader_daily_snapshots') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: dailySnapshots, error: null }),
              }),
            }),
          }),
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      if (table === 'trader_alert_logs' || table === 'alert_history') {
        return {
          insert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      if (table === 'notifications') {
        return {
          insert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      if (table === 'user_profiles') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createRequest('GET', CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.alertsChecked).toBe(1)
    // ROI changed by 20 (60 - 40), threshold is 5, so should trigger
    expect(body.alertsSent).toBe(1)
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when fetching alerts fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_alerts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createRequest('GET', CRON_SECRET))
    expect(res.status).toBe(500)
  })

  it('returns 500 when an unhandled error occurs', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Connection failed')
    })

    const res = await GET(createRequest('GET', CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('Connection failed')
  })
})
