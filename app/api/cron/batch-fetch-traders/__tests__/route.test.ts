/**
 * Cron: batch-fetch-traders route tests
 * Tests auth, group validation, and platform dispatching.
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


jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({
        success: jest.fn(),
        error: jest.fn(),
        timeout: jest.fn(),
      })
    ),
  },
}))

const mockFetcher = jest.fn()
jest.mock('@/lib/cron/fetchers', () => ({
  getInlineFetcher: jest.fn(() => mockFetcher),
}))

jest.mock('@/lib/cron/utils', () => ({
  createSupabaseAdmin: jest.fn(() => ({})),
}))

jest.mock('@/lib/utils/pipeline-monitor', () => ({
  recordFetchResult: jest.fn(),
}))

// Mock connector framework (code uses connectors now, not inline fetchers)
const mockRunConnectorBatch = jest.fn().mockResolvedValue({
  source: 'test',
  periods: { '7d': { saved: 10 }, '30d': { saved: 10 }, '90d': { saved: 10 } },
  duration: 100,
})

jest.mock('@/lib/connectors/connector-db-adapter', () => ({
  runConnectorBatch: (...args: unknown[]) => mockRunConnectorBatch(...args),
}))

jest.mock('@/lib/connectors/registry', () => ({
  connectorRegistry: {
    get: jest.fn(() => ({ platform: 'test', marketType: 'futures' })),
    getOrInit: jest.fn().mockResolvedValue({ platform: 'test', marketType: 'futures' }),
  },
  initializeConnectors: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/constants/exchanges', () => ({
  SOURCE_TO_CONNECTOR_MAP: {
    binance_futures: { platform: 'binance', marketType: 'futures' },
    binance_spot: { platform: 'binance', marketType: 'spot' },
    bybit: { platform: 'bybit', marketType: 'futures' },
    bitget_futures: { platform: 'bitget', marketType: 'futures' },
    okx_futures: { platform: 'okx', marketType: 'futures' },
    hyperliquid: { platform: 'hyperliquid', marketType: 'perp' },
    gmx: { platform: 'gmx', marketType: 'perp' },
    bitunix: { platform: 'bitunix', marketType: 'futures' },
    gains: { platform: 'gains', marketType: 'perp' },
    htx_futures: { platform: 'htx', marketType: 'futures' },
    bitfinex: { platform: 'bitfinex', marketType: 'futures' },
    coinex: { platform: 'coinex', marketType: 'futures' },
    binance_web3: { platform: 'binance_web3', marketType: 'futures' },
    mexc: { platform: 'mexc', marketType: 'futures' },
    bingx: { platform: 'bingx', marketType: 'futures' },
    gateio: { platform: 'gateio', marketType: 'futures' },
    btcc: { platform: 'btcc', marketType: 'futures' },
    drift: { platform: 'drift', marketType: 'perp' },
    jupiter_perps: { platform: 'jupiter_perps', marketType: 'perp' },
    web3_bot: { platform: 'web3_bot', marketType: 'spot' },
    toobit: { platform: 'toobit', marketType: 'futures' },
    etoro: { platform: 'etoro', marketType: 'spot' },
  },
  DEAD_BLOCKED_PLATFORMS: [],
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/lib/logger', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() }
  return {
    __esModule: true,
    default: mockLogger,
    logger: mockLogger,
    logError: jest.fn(),
    logWarn: jest.fn(),
    logInfo: jest.fn(),
    logDebug: jest.fn(),
    logApiError: jest.fn(),
    logDbError: jest.fn(),
  }
})

jest.mock('@/lib/cache', () => ({
  incr: jest.fn().mockResolvedValue(1),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string, group?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  const url = `http://localhost:3000/api/cron/batch-fetch-traders${group ? `?group=${group}` : ''}`
  return new NextRequest(url, { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/batch-fetch-traders', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    // Default: connector returns success with no errors
    mockRunConnectorBatch.mockResolvedValue({
      source: 'test',
      periods: { '7d': { saved: 10 }, '30d': { saved: 10 }, '90d': { saved: 10 } },
      duration: 100,
    })
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing from request', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await GET(createCronRequest('wrong-secret'))
    expect(res.status).toBe(401)
  })

  // ---- Validation ----------------------------------------------------------

  it('returns 400 for unknown group', async () => {
    const res = await GET(createCronRequest(CRON_SECRET, 'z'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Unknown group')
  })

  // ---- Successful execution ------------------------------------------------

  it('dispatches all platforms in group and returns stats', async () => {
    const res = await GET(createCronRequest(CRON_SECRET, 'a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.group).toBe('a')
    expect(body.platforms).toBe(2) // Group a: binance_futures, binance_spot
    // Both platforms have connectors and succeed (binance_spot is no longer disabled)
    expect(body.succeeded).toBe(2)
    expect(body.failed).toBe(0)
    expect(body.ok).toBe(true)
    expect(mockRunConnectorBatch).toHaveBeenCalledTimes(2)
  })

  // ---- Partial failure -----------------------------------------------------

  it('reports partial failures when some platforms fail', async () => {
    // Make connector return an error (0 saved = failure)
    mockRunConnectorBatch.mockResolvedValue({
      source: 'test',
      periods: { '7d': { saved: 0, error: 'API error' } },
      duration: 100,
    })

    const res = await GET(createCronRequest(CRON_SECRET, 'a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    // Both platforms fail: binance_futures and binance_spot (0 saved = error)
    expect(body.failed).toBe(2)
    expect(body.results.find((r: { status: string }) => r.status === 'error')).toBeDefined()
  })

  // ---- Fetcher error -------------------------------------------------------

  it('handles fetcher errors gracefully', async () => {
    mockRunConnectorBatch.mockRejectedValue(new Error('Network error'))

    const res = await GET(createCronRequest(CRON_SECRET, 'a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.failed).toBe(2)
    // Both binance_futures and binance_spot fail with "Network error"
    expect(body.results.some((r: { error?: string }) => r.error?.includes('Network error'))).toBe(true)
  })
})
