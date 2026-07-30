/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mockVerifyCronSecret = jest.fn()
const mockAcquireCronLock = jest.fn()
const mockReleaseLock = jest.fn()
const mockPipelineStart = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockRpc = jest.fn()
const mockSendNotification = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: (...args: unknown[]) => mockVerifyCronSecret(...args),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: (...args: unknown[]) => mockPipelineStart(...args),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { GET } from '../route'

const ATTRIBUTION_ONE = '11111111-1111-4111-8111-111111111111'
const ATTRIBUTION_TWO = '22222222-2222-4222-8222-222222222222'
const REFERRED_ID = '33333333-3333-4333-8333-333333333333'
const REFERRER_ID = '44444444-4444-4444-8444-444444444444'
const REWARD_ID = '55555555-5555-4555-8555-555555555555'
const QUALIFIED_AT = '2026-07-29T10:00:00.000Z'

function qualifiedAck(attributionId = ATTRIBUTION_ONE, overrides: Record<string, unknown> = {}) {
  return {
    data: {
      status: 'qualified',
      attribution_id: attributionId,
      referred_id: REFERRED_ID,
      referrer_id: REFERRER_ID,
      qualified_at: QUALIFIED_AT,
      friend_status: 'granted',
      advocate_status: 'pending',
      advocate_reward_id: null,
      qualified_referral_count: 1,
      qualified_window_minutes: 0,
      ...overrides,
    },
    error: null,
  }
}

describe('GET /api/cron/qualify-referrals retryable authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(true)
    mockAcquireCronLock.mockResolvedValue({ status: 'acquired', release: mockReleaseLock })
    mockPipelineStart.mockResolvedValue({
      success: mockPipelineSuccess,
      error: mockPipelineError,
    })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc })
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_referral_qualification_candidates_atomic') {
        return Promise.resolve({ data: [{ id: ATTRIBUTION_ONE }], error: null })
      }
      if (name === 'qualify_referral_attribution_atomic') {
        return Promise.resolve(qualifiedAck())
      }
      throw new Error(`unexpected RPC ${name}`)
    })
  })

  it('rejects an unauthenticated cron call before acquiring work', async () => {
    mockVerifyCronSecret.mockReturnValue(false)

    const response = await GET({} as never)

    expect(response.status).toBe(401)
    expect(mockAcquireCronLock).not.toHaveBeenCalled()
  })

  it('skips an overlapping run before creating a pipeline attempt', async () => {
    mockAcquireCronLock.mockResolvedValue({ status: 'contended' })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 'skipped',
      reason: 'already running',
    })
    expect(mockPipelineStart).not.toHaveBeenCalled()
  })

  it('fails closed before creating a pipeline attempt when lock authority is unavailable', async () => {
    mockAcquireCronLock.mockResolvedValue({ status: 'unavailable' })

    const response = await GET({} as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: 'error',
      reason: 'lock_unavailable',
    })
    expect(mockPipelineStart).not.toHaveBeenCalled()
  })

  it('keeps a true empty candidate set distinct from a query failure', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      qualified: 0,
      friendGrants: 0,
      advocateGrants: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
    })
    expect(mockPipelineSuccess).toHaveBeenCalledWith(0)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('claim_referral_qualification_candidates_atomic', {
      p_now: expect.any(String),
      p_limit: 500,
    })
    expect(mockReleaseLock).toHaveBeenCalled()
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'read failed' } }],
    ['null row set', { data: null, error: null }],
    ['malformed candidate', { data: [{ id: '' }], error: null }],
  ])('fails the run on a %s candidate response', async (_label, queryResult) => {
    mockRpc.mockResolvedValueOnce(queryResult)

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockReleaseLock).toHaveBeenCalled()
  })

  it('settles qualification and both grants through one exact RPC', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: [{ id: ATTRIBUTION_ONE }], error: null })
      .mockResolvedValueOnce(
        qualifiedAck(ATTRIBUTION_ONE, {
          advocate_status: 'granted',
          advocate_reward_id: REWARD_ID,
          qualified_referral_count: 3,
          qualified_window_minutes: 30,
        })
      )

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('qualify_referral_attribution_atomic', {
      p_attribution_id: ATTRIBUTION_ONE,
      p_now: expect.any(String),
      p_min_age_hours: 24,
      p_friend_days: 7,
      p_device_cap: 3,
      p_advocate_threshold: 3,
      p_advocate_days: 30,
    })
    expect(mockSendNotification).toHaveBeenCalledTimes(2)
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        user_id: REFERRED_ID,
        reference_id: `friend:${ATTRIBUTION_ONE}`,
      }),
      'Referral friend reward notification',
      { deduplicate: true, dedupWindowSeconds: 604800 }
    )
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        user_id: REFERRER_ID,
        reference_id: `advocate:${REWARD_ID}`,
      }),
      'Referral advocate reward notification',
      { deduplicate: true, dedupWindowSeconds: 604800 }
    )
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      qualified: 1,
      friendGrants: 1,
      advocateGrants: 1,
      failed: 0,
    })
  })

  it('leaves a not-yet-eligible attribution pending without reporting success work', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: [{ id: ATTRIBUTION_ONE }], error: null })
      .mockResolvedValueOnce({
        data: { status: 'not_eligible', attribution_id: ATTRIBUTION_ONE },
        error: null,
      })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      qualified: 0,
      pending: 1,
      failed: 0,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each(['not_found', 'owner_unavailable'] as const)(
    'treats an exact %s result as an authoritative skip',
    async (status) => {
      mockRpc
        .mockResolvedValueOnce({ data: [{ id: ATTRIBUTION_ONE }], error: null })
        .mockResolvedValueOnce({
          data: status === 'not_found' ? { status } : { status, attribution_id: ATTRIBUTION_ONE },
          error: null,
        })

      const response = await GET({} as never)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ skipped: 1, failed: 0 })
    }
  )

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'rpc failed' } }],
    ['null result', { data: null, error: null }],
    ['unknown status', { data: { status: 'ok' }, error: null }],
    [
      'wrong attribution identity',
      {
        data: {
          ...qualifiedAck().data,
          attribution_id: '66666666-6666-4666-8666-666666666666',
        },
        error: null,
      },
    ],
    [
      'contradictory pending reward identity',
      { data: { ...qualifiedAck().data, advocate_reward_id: REWARD_ID }, error: null },
    ],
    [
      'zero qualified count',
      { data: { ...qualifiedAck().data, qualified_referral_count: 0 }, error: null },
    ],
    [
      'extra acknowledgement field',
      { data: { ...qualifiedAck().data, unexpected: true }, error: null },
    ],
  ])('fails closed on a %s qualification acknowledgement', async (_label, rpcResult) => {
    mockRpc
      .mockResolvedValueOnce({ data: [{ id: ATTRIBUTION_ONE }], error: null })
      .mockResolvedValueOnce(rpcResult)

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ failed: 1 })
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('continues later candidates but reports a partial batch failure', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: [{ id: ATTRIBUTION_ONE }, { id: ATTRIBUTION_TWO }],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'failed' } })
      .mockResolvedValueOnce(qualifiedAck(ATTRIBUTION_TWO))

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(3)
    await expect(response.json()).resolves.toMatchObject({
      qualified: 1,
      friendGrants: 1,
      failed: 1,
    })
  })

  it('contains no direct qualification, marker, or entitlement mutation fallback', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/api/cron/qualify-referrals/route.ts'),
      'utf8'
    )

    expect(source).toContain("'qualify_referral_attribution_atomic'")
    expect(source).not.toContain('.update(')
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.delete(')
    expect(source).not.toContain('grantProDays')
  })
})
