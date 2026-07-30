/**
 * @jest-environment node
 */

import type { NextRequest } from 'next/server'

const mockVerifyCronSecret = jest.fn(() => true)
const mockAcquireCronLock = jest.fn()
const mockReleaseCronLock = jest.fn()
const mockPlogSuccess = jest.fn()
const mockPlogError = jest.fn()
const mockPipelineStateSet = jest.fn()
const mockGetSupabaseAdmin = jest.fn(() => ({ name: 'admin-client' }))
const mockRebuild = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: (...args: unknown[]) => mockVerifyCronSecret(...args),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}))

jest.mock('@/lib/search/rebuild-meilisearch-traders', () => ({
  rebuildMeilisearchTraders: (...args: unknown[]) => mockRebuild(...args),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(async () => ({
      success: mockPlogSuccess,
      error: mockPlogError,
    })),
  },
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    set: (...args: unknown[]) => mockPipelineStateSet(...args),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { GET } from '../route'

const SUCCESS_RESULT = Object.freeze({
  mode: 'authoritative',
  candidate_uid: 'traders_build_test',
  task_count: 5,
  evidence: Object.freeze({
    contract_version: 'meilisearch-authoritative-rebuild-v1',
    total_count: 3,
    season_counts: Object.freeze({ '7D': 1, '30D': 1, '90D': 1 }),
    sorted_id_sha256: 'a'.repeat(64),
  }),
})

function request(): NextRequest {
  const { NextRequest } = jest.requireActual<typeof import('next/server')>('next/server')
  return new NextRequest('http://localhost:3000/api/cron/sync-meilisearch', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

describe('GET /api/cron/sync-meilisearch', () => {
  beforeAll(() => {
    process.env.MEILISEARCH_URL = 'https://meili.test'
    process.env.MEILISEARCH_ADMIN_KEY = 'test-admin-key'
  })

  afterAll(() => {
    delete process.env.MEILISEARCH_URL
    delete process.env.MEILISEARCH_ADMIN_KEY
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(true)
    mockAcquireCronLock.mockResolvedValue({ status: 'acquired', release: mockReleaseCronLock })
    mockReleaseCronLock.mockResolvedValue(undefined)
    mockPipelineStateSet.mockResolvedValue(undefined)
    mockPlogSuccess.mockResolvedValue(undefined)
    mockPlogError.mockResolvedValue(undefined)
    mockRebuild.mockResolvedValue(SUCCESS_RESULT)
  })

  it('publishes an authoritative result and advances state only after the runner completes', async () => {
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      ok: true,
      traders: 3,
      seasons: { '7D': 1, '30D': 1, '90D': 1 },
      sorted_id_sha256: 'a'.repeat(64),
      tasks: 5,
      elapsed_ms: expect.any(Number),
      mode: 'authoritative',
    })
    expect(mockRebuild).toHaveBeenCalledWith({
      supabase: { name: 'admin-client' },
      meiliUrl: 'https://meili.test',
      meiliAdminKey: 'test-admin-key',
      timeBudgetMs: 90_000,
    })
    expect(mockPipelineStateSet).toHaveBeenCalledWith(
      'meilisearch:last_sync',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    )
    expect(mockRebuild.mock.invocationCallOrder[0]).toBeLessThan(
      mockPipelineStateSet.mock.invocationCallOrder[0]
    )
    expect(mockPlogSuccess).toHaveBeenCalledTimes(1)
    expect(mockPlogError).not.toHaveBeenCalled()
    expect(mockReleaseCronLock).toHaveBeenCalledTimes(1)
  })

  it('fails closed without advancing state when reconciliation or task ACK fails', async () => {
    mockRebuild.mockRejectedValue(new Error('task 42 did not succeed'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toMatchObject({
      ok: false,
      error: 'Meilisearch authoritative rebuild failed',
      mode: 'authoritative',
    })
    expect(body.error).not.toContain('task 42')
    expect(mockPipelineStateSet).not.toHaveBeenCalled()
    expect(mockPlogSuccess).not.toHaveBeenCalled()
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    expect(mockReleaseCronLock).toHaveBeenCalledTimes(1)
  })

  it('does not report success when the post-ACK state marker cannot be persisted', async () => {
    mockPipelineStateSet.mockRejectedValue(new Error('state unavailable'))

    const response = await GET(request())

    expect(response.status).toBe(502)
    expect(mockRebuild).toHaveBeenCalledTimes(1)
    expect(mockPlogSuccess).not.toHaveBeenCalled()
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    expect(mockReleaseCronLock).toHaveBeenCalledTimes(1)
  })

  it('rejects unauthorized and unconfigured calls before acquiring the lock', async () => {
    mockVerifyCronSecret.mockReturnValue(false)
    const unauthorized = await GET(request())
    expect(unauthorized.status).toBe(401)
    expect(mockAcquireCronLock).not.toHaveBeenCalled()

    mockVerifyCronSecret.mockReturnValue(true)
    delete process.env.MEILISEARCH_ADMIN_KEY
    const unconfigured = await GET(request())
    expect(unconfigured.status).toBe(503)
    expect(mockAcquireCronLock).not.toHaveBeenCalled()
    process.env.MEILISEARCH_ADMIN_KEY = 'test-admin-key'
  })

  it('skips an overlapping run without creating a pipeline record', async () => {
    mockAcquireCronLock.mockResolvedValue({ status: 'contended' })

    const response = await GET(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 'skipped',
      reason: 'already running',
    })
    expect(mockRebuild).not.toHaveBeenCalled()
    expect(mockPipelineStateSet).not.toHaveBeenCalled()
  })

  it('returns 503 when the distributed lock authority is unavailable', async () => {
    mockAcquireCronLock.mockResolvedValue({ status: 'unavailable' })

    const response = await GET(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: 'error',
      reason: 'lock_unavailable',
    })
    expect(mockRebuild).not.toHaveBeenCalled()
  })

  it('contains no incremental or unsealed leaderboard fallback in the route', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs')
    const route = fs.readFileSync(require.resolve('../route'), 'utf8')

    expect(route).toContain('rebuildMeilisearchTraders')
    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain("gte('computed_at'")
    expect(route).not.toContain('isFull')
  })
})
