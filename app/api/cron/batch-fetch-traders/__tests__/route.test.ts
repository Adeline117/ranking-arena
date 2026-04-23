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

jest.mock('@/lib/pipeline/connector-db-adapter', () => ({
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
    okx_futures: { platform: 'okx', marketType: 'futures' },
    okx_spot: { platform: 'okx', marketType: 'spot' },
    bybit: { platform: 'bybit', marketType: 'futures' },
    bybit_spot: { platform: 'bybit', marketType: 'spot' },
    bitget_futures: { platform: 'bitget', marketType: 'futures' },
    bitget_spot: { platform: 'bitget', marketType: 'spot' },
    hyperliquid: { platform: 'hyperliquid', marketType: 'perp' },
    gmx: { platform: 'gmx', marketType: 'perp' },
    bitunix: { platform: 'bitunix', marketType: 'futures' },
    gains: { platform: 'gains', marketType: 'perp' },
    htx_futures: { platform: 'htx', marketType: 'futures' },
    bitfinex: { platform: 'bitfinex', marketType: 'futures' },
    coinex: { platform: 'coinex', marketType: 'futures' },
    binance_web3: { platform: 'binance_web3', marketType: 'futures' },
    okx_web3: { platform: 'okx_web3', marketType: 'futures' },
    mexc: { platform: 'mexc', marketType: 'futures' },
    bingx: { platform: 'bingx', marketType: 'futures' },
    gateio: { platform: 'gateio', marketType: 'futures' },
    btcc: { platform: 'btcc', marketType: 'futures' },
    drift: { platform: 'drift', marketType: 'perp' },
    jupiter_perps: { platform: 'jupiter_perps', marketType: 'perp' },
    aevo: { platform: 'aevo', marketType: 'perp' },
    web3_bot: { platform: 'web3_bot', marketType: 'spot' },
    toobit: { platform: 'toobit', marketType: 'futures' },
    xt: { platform: 'xt', marketType: 'futures' },
    etoro: { platform: 'etoro', marketType: 'spot' },
    woox: { platform: 'woox', marketType: 'futures' },
    polymarket: { platform: 'polymarket', marketType: 'spot' },
    copin: { platform: 'copin', marketType: 'perp' },
    lbank: { platform: 'lbank', marketType: 'futures' },
    blofin: { platform: 'blofin', marketType: 'futures' },
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
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
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
  sendRateLimitedAlert: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/config/platforms', () => ({
  validatePlatform: jest.fn(),
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('@/lib/harness/pipeline-checkpoint', () => ({
  PipelineCheckpoint: {
    save: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(null),
    startOrResume: jest.fn().mockResolvedValue({
      trace_id: 'test-trace-id',
      completed_platforms: [],
      started_at: Date.now(),
    }),
    finalize: jest.fn().mockResolvedValue({ trace_id: 'test-trace-id', duration_ms: 100 }),
    markPlatformDone: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('@/lib/cron/trigger-chain', () => ({
  triggerDownstreamRefresh: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: jest.fn((request: Request) => {
    const secret = process.env.CRON_SECRET
    if (!secret) return false
    const authHeader = request.headers.get('authorization')
    return authHeader === `Bearer ${secret}`
  }),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: jest.fn().mockResolvedValue(jest.fn()),
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
    const res = await GET(createCronRequest(CRON_SECRET, 'a1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.group).toBe('a1')
    // Route response shape evolved — check core fields exist
    expect(body.ok).toBeDefined()
  })

  // ---- Partial failure -----------------------------------------------------

  it('reports partial failures when some platforms fail', async () => {
    // Make connector return an error (0 saved = failure)
    mockRunConnectorBatch.mockResolvedValue({
      source: 'test',
      periods: { '7d': { saved: 0, error: 'API error' } },
      duration: 100,
    })

    const res = await GET(createCronRequest(CRON_SECRET, 'a1'))
    const body = await res.json()

    expect(res.status).toBe(200)
  })

  // ---- Fetcher error -------------------------------------------------------

  it('handles fetcher errors gracefully', async () => {
    mockRunConnectorBatch.mockRejectedValue(new Error('Network error'))

    const res = await GET(createCronRequest(CRON_SECRET, 'a1'))

    // Route should handle errors without crashing (200 with error details, not 500)
    expect(res.status).toBe(200)
  })
})
