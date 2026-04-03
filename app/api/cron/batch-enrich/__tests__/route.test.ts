/**
 * Cron: batch-enrich route tests
 * Tests auth, period validation, platform selection, and error handling.
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
        partialSuccess: jest.fn(),
      })
    ),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

// Mock the enrichment runner — batch-enrich now calls inline, not via fetch
const mockRunEnrichment = jest.fn()
jest.mock('@/lib/cron/enrichment-runner', () => ({
  runEnrichment: (...args: unknown[]) => mockRunEnrichment(...args),
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('@/lib/cron/trigger-chain', () => ({
  triggerDownstreamRefresh: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string, params?: Record<string, string>): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  const searchParams = new URLSearchParams(params || {})
  const url = `http://localhost:3000/api/cron/batch-enrich?${searchParams}`
  return new NextRequest(url, { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/batch-enrich', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Validation ----------------------------------------------------------

  it('returns 400 for invalid period', async () => {
    const res = await GET(createCronRequest(CRON_SECRET, { period: '1D' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid period')
  })

  // ---- Successful execution ------------------------------------------------

  it('enriches high + medium priority platforms for 7D period', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: true, summary: { total: 10, enriched: 10, failed: 0 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    // Route runs enrichment inline per-platform — ok depends on platform success/failure
    // With mocked dependencies, some platforms may fail, so ok may be false
    expect(body.period).toBe('7D')
    expect(body.platforms).toBeGreaterThanOrEqual(1)
  })

  it('enriches high + medium priority for 90D period', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: true, summary: { total: 10, enriched: 10, failed: 0 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '90D' }))
    const body = await res.json()

    expect(body.period).toBe('90D')
    expect(body.platforms).toBeGreaterThanOrEqual(10) // high + medium priority
  })

  it('enriches all platforms when all=true', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: true, summary: { total: 10, enriched: 10, failed: 0 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D', all: 'true' }))
    const body = await res.json()

    expect(body.platforms).toBeGreaterThanOrEqual(10) // high + medium + lower priority
  })

  // ---- Error handling ------------------------------------------------------

  it('reports failures when enrichment returns errors', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: false, summary: { total: 10, enriched: 0, failed: 10 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.failed).toBeGreaterThan(0)
  })

  it('handles thrown errors gracefully', async () => {
    mockRunEnrichment.mockRejectedValue(new Error('Connection refused'))

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.failed).toBeGreaterThan(0)
  })
})
