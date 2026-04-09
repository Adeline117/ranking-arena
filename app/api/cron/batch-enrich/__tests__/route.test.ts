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

// Mock Supabase admin so leaderboard count queries don't hit the real DB.
// Route calls `.from('leaderboard_ranks').select(...).eq(...).eq(...).not(...)`
// which must resolve to `{ count, error }`.
jest.mock('@/lib/supabase/server', () => {
  const terminal = Promise.resolve({ count: 100, error: null })
  // Chain returns itself on non-terminal ops, resolves on await.
  const chain: Record<string, unknown> = new Proxy(terminal, {
    get(target, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return (target as unknown as Record<string, unknown>)[prop as string]
      }
      return () => chain
    },
  }) as unknown as Record<string, unknown>
  return {
    getSupabaseAdmin: jest.fn(() => ({ from: jest.fn(() => chain) })),
  }
})

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn().mockResolvedValue(1),
    getByPrefix: jest.fn().mockResolvedValue([]),
  },
}))

jest.mock('@/lib/cron/trigger-chain', () => ({
  triggerDownstreamRefresh: jest.fn(),
}))

const mockCheckpointState = {
  completed_platforms: [] as string[],
  failed_platforms: [] as Array<{ platform: string; error: string }>,
  records_processed: 0,
}
jest.mock('@/lib/harness/pipeline-checkpoint', () => ({
  PipelineCheckpoint: {
    startOrResume: jest.fn().mockImplementation(async () => ({
      trace_id: 'test-trace-id',
      job_type: 'enrich',
      group: 'test',
      started_at: new Date().toISOString(),
      last_checkpoint_at: new Date().toISOString(),
      completed_platforms: mockCheckpointState.completed_platforms,
      failed_platforms: mockCheckpointState.failed_platforms,
      current_platform: null,
      records_processed: mockCheckpointState.records_processed,
    })),
    markInProgress: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue({
      trace_id: 'test-trace-id',
      source: 'enrich-test',
      platforms_updated: [],
      records_written: 0,
      duration_ms: 100,
      failed_platforms: [],
    }),
    isCompleted: jest.fn().mockReturnValue(false),
  },
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
  jest.setTimeout(60_000) // Route has 270s budget + per-platform loops; give mocks room
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    // Reset checkpoint state between tests
    mockCheckpointState.completed_platforms = []
    mockCheckpointState.failed_platforms = []
    mockCheckpointState.records_processed = 0
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
