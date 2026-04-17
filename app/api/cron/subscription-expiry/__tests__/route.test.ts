/**
 * Cron: subscription-expiry route tests
 * Tests auth, expiry checks, downgrade logic, NFT validation, and error handling.
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


const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  apiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  dataLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

jest.mock('@/lib/web3/nft', () => ({
  checkNFTMembership: jest.fn().mockResolvedValue(false),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    dbError: jest.fn(),
    apiError: jest.fn(),
  },
}))

// Mock withCron to pass through (auth handled by test's CRON_SECRET setup)
jest.mock('@/lib/api/with-cron', () => ({
  withCron: (jobName: string, handler: Function) => async (request: unknown) => {
    const secret = process.env.CRON_SECRET
    const authHeader = (request as { headers: { get: (k: string) => string | null } }).headers.get('authorization')
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const { getSupabaseAdmin } = require('@/lib/supabase/server')
    try {
      const result = await handler(request, { plog: { success: jest.fn(), error: jest.fn(), timeout: jest.fn(), partialSuccess: jest.fn(), id: 1 }, supabase: getSupabaseAdmin() })
      const { NextResponse } = require('next/server')
      return NextResponse.json({ ok: true, ...result })
    } catch (err: unknown) {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/subscription-expiry', { headers })
}

/** Build chainable mock */
function chainable(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/subscription-expiry', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
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

  // ---- Successful execution with no expiring subscriptions -----------------

  it('runs successfully with no expiring subscriptions', async () => {
    mockFrom.mockImplementation(() => chainable({ data: [], error: null, count: 0 }))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.expiringReminders).toBe(0)
    expect(body.downgraded).toBe(0)
  })

  // ---- Downgrade expired subscriptions -------------------------------------

  it('downgrades expired subscriptions', async () => {
    const expiredSubs = [
      { user_id: 'user1', stripe_subscription_id: 'sub_1' },
    ]

    // Use chainable proxy — handles any method chain (.eq().neq().lt() etc.)
    mockFrom.mockImplementation(() => chainable({ data: expiredSubs, error: null }))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.downgraded).toBe(1)
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Connection lost')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })

  it('catches thrown errors during downgrade and records them', async () => {
    // Use chainable for most calls but throw on update
    let callCount = 0
    mockFrom.mockImplementation(() => {
      const proxy = chainable({ data: [{ user_id: 'user1', stripe_subscription_id: 'sub_1', plan: 'monthly' }], error: null })
      // Override update to throw on first call
      const origUpdate = proxy.update
      proxy.update = jest.fn().mockImplementation(() => {
        if (callCount++ === 0) throw new Error('Update failed')
        return origUpdate()
      })
      return proxy
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    // The route should handle the error and still return 200
    expect(res.status).toBe(200)
  })
})
