/**
 * Cron: batch-fetch-traders route tests
 * Tests auth, successful batch dispatch, partial failures, and error handling.
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

// Mock global fetch for internal API calls
const mockFetch = jest.fn()
global.fetch = mockFetch

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
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('') })

    const promise = GET(createCronRequest(CRON_SECRET, 'a'))
    // Advance past delays between platforms
    await jest.advanceTimersByTimeAsync(30000)
    const res = await promise
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.group).toBe('a')
    expect(body.platforms).toBe(5) // Group a has 5 platforms
    expect(body.succeeded).toBe(5)
    expect(body.failed).toBe(0)
    expect(body.ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  // ---- Partial failure -----------------------------------------------------

  it('reports partial failures when some platforms fail', async () => {
    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount === 2) {
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('Internal error') })
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') })
    })

    const promise = GET(createCronRequest(CRON_SECRET, 'a'))
    await jest.advanceTimersByTimeAsync(30000)
    const res = await promise
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.succeeded).toBe(4)
    expect(body.failed).toBe(1)
    expect(body.results.find((r: { status: string }) => r.status === 'error')).toBeDefined()
  })

  // ---- Network error -------------------------------------------------------

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const promise = GET(createCronRequest(CRON_SECRET, 'a'))
    await jest.advanceTimersByTimeAsync(30000)
    const res = await promise
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.failed).toBe(5)
    expect(body.results.every((r: { error?: string }) => r.error?.includes('Network error'))).toBe(true)
  })
})
