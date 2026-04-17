/**
 * Cron: weekly-report route tests
 * Tests auth, report generation, alert sending, and error handling.
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
const mockSupabaseAdmin = { from: mockFrom }

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseAdmin),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({ success: jest.fn(), error: jest.fn(), timeout: jest.fn() })
    ),
    getJobStats: jest.fn().mockResolvedValue([
      { job_name: 'batch-fetch-traders-a', total_runs: 50, error_count: 2, success_rate: 0.96 },
      { job_name: 'compute-leaderboard', total_runs: 40, error_count: 0, success_rate: 1.0 },
    ]),
    getRecentFailures: jest.fn().mockResolvedValue([
      { job_name: 'batch-fetch-traders-a', error: 'timeout', created_at: new Date().toISOString() },
    ]),
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { sendAlert } from '@/lib/alerts/send-alert'

const mockSendAlert = sendAlert as jest.MockedFunction<typeof sendAlert>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/weekly-report', { headers })
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

describe('GET /api/cron/weekly-report', () => {
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

  it('returns 401 when secret does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Successful report ---------------------------------------------------

  it('generates weekly report and sends alert', async () => {
    mockFrom.mockImplementation(() => {
      // Return a chainable mock that handles all query patterns:
      // .select().gte() -> { count, error }
      // .select().lt().limit() -> { data, error }
      // .select() -> { count, error }
      const makeChain = (): Record<string, jest.Mock> => {
        const chain: Record<string, jest.Mock> = {}
        const handler = () =>
          new Proxy(
            {},
            {
              get(_target, prop) {
                if (prop === 'then') {
                  return (resolve: (v: unknown) => void) =>
                    resolve({ count: 100, data: [], error: null })
                }
                if (!chain[prop as string]) {
                  chain[prop as string] = jest.fn().mockImplementation(handler)
                }
                return chain[prop as string]
              },
            }
          )
        return { select: jest.fn().mockImplementation(handler) }
      }
      return makeChain()
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.count).toBe(90)
    expect(body.totalErrors).toBe(2)
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('每周报告'),
        level: 'info',
      })
    )
  })

  it('sends warning level when success rate is low', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PipelineLogger } = require('@/lib/services/pipeline-logger')
    PipelineLogger.getJobStats.mockResolvedValueOnce([
      { job_name: 'failing-job', total_runs: 100, error_count: 50, success_rate: 0.5 },
    ])

    mockFrom.mockImplementation(() =>
      chainable({ data: [], error: null, count: 0 })
    )

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning' })
    )
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when an error occurs', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('DB crash')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })
})
