/**
 * Cron: batch-enrich route tests
 * Tests auth, period validation, platform selection, and error handling.
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

// Mock the enrichment runner — batch-enrich now calls inline, not via fetch
const mockRunEnrichment = jest.fn()
jest.mock('@/lib/cron/enrichment-runner', () => ({
  runEnrichment: (...args: unknown[]) => mockRunEnrichment(...args),
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
    expect(body.ok).toBe(true)
    expect(body.period).toBe('7D')
    // 7D enriches high + medium priority (6 + 8 = 14 platforms)
    expect(body.platforms).toBe(14)
    expect(body.succeeded).toBe(14)
  })

  it('enriches high + medium priority for 90D period', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: true, summary: { total: 10, enriched: 10, failed: 0 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '90D' }))
    const body = await res.json()

    expect(body.period).toBe('90D')
    expect(body.platforms).toBe(14) // 6 high + 8 medium
  })

  it('enriches all platforms when all=true', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: true, summary: { total: 10, enriched: 10, failed: 0 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D', all: 'true' }))
    const body = await res.json()

    expect(body.platforms).toBe(19) // 6 + 8 + 5
  })

  // ---- Error handling ------------------------------------------------------

  it('reports failures when enrichment returns errors', async () => {
    mockRunEnrichment.mockResolvedValue({ ok: false, summary: { total: 10, enriched: 0, failed: 10 }, results: {} })

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.failed).toBe(14)
  })

  it('handles thrown errors gracefully', async () => {
    mockRunEnrichment.mockRejectedValue(new Error('Connection refused'))

    const res = await GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.failed).toBeGreaterThan(0)
  })
})
