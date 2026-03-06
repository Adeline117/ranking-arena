/**
 * Cron: refresh-views route tests
 * Tests auth, materialized view refresh, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRpc = jest.fn()
const mockSupabaseAdmin = { rpc: mockRpc }

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseAdmin),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
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

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string, useXHeader = false): NextRequest {
  const headers = new Headers()
  if (secret) {
    if (useXHeader) {
      headers.set('x-cron-secret', secret)
    } else {
      headers.set('authorization', `Bearer ${secret}`)
    }
  }
  return new NextRequest('http://localhost:3000/api/cron/refresh-views', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/refresh-views', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when secret does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when no auth header provided', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('accepts x-cron-secret header', async () => {
    mockRpc.mockResolvedValue({ error: null })

    const res = await GET(createCronRequest(CRON_SECRET, true))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })

  // ---- Successful refresh --------------------------------------------------

  it('refreshes materialized views successfully', async () => {
    mockRpc.mockResolvedValue({ error: null })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.views).toEqual(['mv_hourly_prices', 'mv_daily_rankings'])
    expect(body.duration).toBeDefined()
    expect(mockRpc).toHaveBeenCalledWith('refresh_materialized_views')
  })

  // ---- RPC error -----------------------------------------------------------

  it('returns 500 when RPC returns an error', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'relation does not exist' } })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('relation does not exist')
  })

  // ---- Unhandled error -----------------------------------------------------

  it('returns 500 when an unhandled error occurs', async () => {
    mockRpc.mockImplementation(() => {
      throw new Error('Connection refused')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('Connection refused')
  })
})
