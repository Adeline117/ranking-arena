/**
 * Cron: detect-anomalies route tests
 * Tests auth, anomaly detection, disabled state, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/services/anomaly-manager', () => ({
  batchDetectAnomalies: jest.fn(),
  saveAnomalies: jest.fn(),
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
      id: 1,
      success: jest.fn().mockResolvedValue(undefined),
      error: jest.fn().mockResolvedValue(undefined),
      timeout: jest.fn().mockResolvedValue(undefined),
    }),
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { batchDetectAnomalies, saveAnomalies } from '@/lib/services/anomaly-manager'

const mockBatchDetectAnomalies = batchDetectAnomalies as jest.MockedFunction<typeof batchDetectAnomalies>
const mockSaveAnomalies = saveAnomalies as jest.MockedFunction<typeof saveAnomalies>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/detect-anomalies', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/detect-anomalies', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.SUPABASE_URL = 'http://supabase.test'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.ENABLE_ANOMALY_DETECTION
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when secret does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Disabled state ------------------------------------------------------

  it('returns success with skipped when anomaly detection is disabled', async () => {
    process.env.ENABLE_ANOMALY_DETECTION = 'false'

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.stats.skipped).toBe(true)
  })

  // ---- No active traders ---------------------------------------------------

  it('handles no active traders gracefully', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        gte: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.stats.tradersChecked).toBe(0)
  })

  // ---- Successful detection ------------------------------------------------

  it('detects anomalies and saves them', async () => {
    const traderSnapshots = [
      { source_trader_id: 't1', source: 'binance_futures', roi: 500, pnl: 100000, win_rate: 0.99, max_drawdown: -1, trades_count: 10 },
      { source_trader_id: 't2', source: 'bybit', roi: 20, pnl: 5000, win_rate: 0.6, max_drawdown: -10, trades_count: 50 },
    ]

    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        gte: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({ data: traderSnapshots, error: null }),
        }),
      }),
    })

    const anomalyMap = new Map()
    anomalyMap.set('t1:binance_futures', [
      { severity: 'critical', type: 'suspicious_roi', trader_id: 't1' },
    ])
    mockBatchDetectAnomalies.mockResolvedValue(anomalyMap)
    mockSaveAnomalies.mockResolvedValue(undefined)

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.stats.tradersChecked).toBe(2)
    expect(body.stats.anomaliesDetected).toBe(1)
    expect(body.stats.criticalAnomalies).toBe(1)
    expect(mockSaveAnomalies).toHaveBeenCalled()
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database query fails', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        gte: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
        }),
      }),
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('returns 500 when anomaly detection throws', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        gte: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({
            data: [{ source_trader_id: 't1', source: 'bybit', roi: 10, pnl: 100, win_rate: null, max_drawdown: null, trades_count: null }],
            error: null,
          }),
        }),
      }),
    })

    mockBatchDetectAnomalies.mockRejectedValue(new Error('Detection engine crashed'))

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('Detection engine crashed')
  })
})
