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

const mockFetch = jest.fn()
global.fetch = mockFetch

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
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers({ advanceTimers: true })
  })

  afterEach(() => {
    jest.useRealTimers()
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

  it('enriches high-priority platforms for 7D period', async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const promise = GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    await jest.advanceTimersByTimeAsync(60000)
    const res = await promise
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.period).toBe('7D')
    // 7D only enriches high-priority (6 platforms)
    expect(body.platforms).toBe(6)
    expect(body.succeeded).toBe(6)
  })

  it('enriches high + medium priority for 90D period', async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const promise = GET(createCronRequest(CRON_SECRET, { period: '90D' }))
    await jest.advanceTimersByTimeAsync(120000)
    const res = await promise
    const body = await res.json()

    expect(body.period).toBe('90D')
    expect(body.platforms).toBe(12) // 6 high + 6 medium
  })

  it('enriches all platforms when all=true', async () => {
    mockFetch.mockResolvedValue({ ok: true })

    const promise = GET(createCronRequest(CRON_SECRET, { period: '7D', all: 'true' }))
    await jest.advanceTimersByTimeAsync(120000)
    const res = await promise
    const body = await res.json()

    expect(body.platforms).toBe(16) // 6 + 6 + 4
  })

  // ---- Error handling ------------------------------------------------------

  it('reports failures when enrichment API returns errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })

    const promise = GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    await jest.advanceTimersByTimeAsync(60000)
    const res = await promise
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.failed).toBe(6)
  })

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'))

    const promise = GET(createCronRequest(CRON_SECRET, { period: '7D' }))
    await jest.advanceTimersByTimeAsync(60000)
    const res = await promise
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.failed).toBeGreaterThan(0)
  })
})
