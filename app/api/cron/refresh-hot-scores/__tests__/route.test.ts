/**
 * Cron: refresh-hot-scores route tests
 * Tests auth, incremental/full/fallback refresh paths, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockSupabaseAdmin = { rpc: mockRpc, from: mockFrom }

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseAdmin),
}))

jest.mock('@/lib/cache', () => ({
  del: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/refresh-hot-scores', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/refresh-hot-scores', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when no auth header provided', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  // ---- Incremental refresh (happy path) ------------------------------------

  it('performs incremental refresh successfully', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'update_post_velocity') return Promise.resolve({ data: 10, error: null })
      if (name === 'update_post_report_counts') return Promise.resolve({ data: 5, error: null })
      if (name === 'refresh_hot_scores_incremental') return Promise.resolve({ data: 42, error: null })
      return Promise.resolve({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.method).toBe('incremental')
    expect(body.count).toBe(42)
    expect(body.velocityUpdated).toBe(10)
  })

  // ---- Full refresh fallback -----------------------------------------------

  it('falls back to full refresh when incremental fails', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'update_post_velocity') return Promise.resolve({ data: 0, error: null })
      if (name === 'update_post_report_counts') return Promise.resolve({ data: 0, error: null })
      if (name === 'refresh_hot_scores_incremental') return Promise.resolve({ data: null, error: { message: 'function not found' } })
      if (name === 'refresh_hot_scores') return Promise.resolve({ data: 100, error: null })
      return Promise.resolve({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.method).toBe('full')
    expect(body.count).toBe(100)
  })

  // ---- Direct update fallback ----------------------------------------------

  it('falls back to direct post updates when all RPCs fail', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function not found' } })

    const posts = [
      { id: 'p1', like_count: 10, comment_count: 5, repost_count: 2, view_count: 100, created_at: new Date(Date.now() - 3600000).toISOString() },
    ]

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        gte: jest.fn().mockResolvedValue({ data: posts, error: null }),
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    }))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.method).toBe('fallback')
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when an unhandled error occurs', async () => {
    mockRpc.mockImplementation(() => {
      throw new Error('Database crash')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('returns 500 when all RPCs fail and post fetch also fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'not found' } })

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        gte: jest.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
      }),
    }))

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })
})
