/**
 * Cron: batch-fetch-traders route tests
 * Tests auth, group validation, and platform dispatching.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return {
    __esModule: true,
    default: mockLogger,
    logger: mockLogger,
    logError: jest.fn(),
    logWarn: jest.fn(),
    logInfo: jest.fn(),
    logDebug: jest.fn(),
  }
})

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
    // Default: fetcher returns success with no errors
    mockFetcher.mockResolvedValue({
      source: 'test',
      periods: { '7D': { saved: 10 }, '30D': { saved: 10 }, '90D': { saved: 10 } },
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
    expect(body.platforms).toBe(2) // Group a: bitget_futures, okx_futures
    expect(body.succeeded).toBe(2)
    expect(body.failed).toBe(0)
    expect(body.ok).toBe(true)
    expect(mockFetcher).toHaveBeenCalledTimes(2)
  })

  // ---- Partial failure -----------------------------------------------------

  it('reports partial failures when some platforms fail', async () => {
    let callCount = 0
    mockFetcher.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          source: 'test',
          periods: { '7D': { saved: 0, error: 'API error' } },
          duration: 100,
        })
      }
      return Promise.resolve({
        source: 'test',
        periods: { '7D': { saved: 10 }, '30D': { saved: 10 }, '90D': { saved: 10 } },
        duration: 100,
      })
    })

    const res = await GET(createCronRequest(CRON_SECRET, 'a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.succeeded).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.results.find((r: { status: string }) => r.status === 'error')).toBeDefined()
  })

  // ---- Fetcher error -------------------------------------------------------

  it('handles fetcher errors gracefully', async () => {
    mockFetcher.mockRejectedValue(new Error('Network error'))

    const res = await GET(createCronRequest(CRON_SECRET, 'a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.failed).toBe(2)
    expect(body.results.every((r: { error?: string }) => r.error?.includes('Network error'))).toBe(true)
  })
})
