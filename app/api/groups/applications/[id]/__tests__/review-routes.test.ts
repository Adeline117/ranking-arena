jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }
    async json() {
      return this._body
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    method: string
    headers: { get: (name: string) => string | null }
    private readonly rawBody: string
    constructor(
      url: string,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {}
    ) {
      this.url = url
      this.method = init.method ?? 'POST'
      const headers = new Map(Object.entries(init.headers ?? {}))
      this.headers = { get: (name: string) => headers.get(name) ?? null }
      this.rawBody = init.body ?? ''
    }
    async json() {
      if (!this.rawBody) throw new Error('missing body')
      return JSON.parse(this.rawBody)
    }
    async text() {
      return this.rawBody
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockVerifyAdmin = jest.fn()
const mockSendNotification = jest.fn()
const mockNotifyNewGroup = jest.fn()
const mockSupabase = { rpc: mockRpc, from: mockFrom }

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => mockSupabase }))
jest.mock('@/lib/admin/auth', () => ({
  verifyAdmin: (...args: unknown[]) => mockVerifyAdmin(...args),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/notifications/activity-alerts', () => ({
  notifyNewGroup: (...args: unknown[]) => mockNotifyNewGroup(...args),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { POST as approve } from '../approve/route'
import { POST as reject } from '../reject/route'

const REVIEWER_ID = '11111111-1111-4111-8111-111111111111'
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222'
const APPLICANT_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const OPERATION_ID = '55555555-5555-4555-8555-555555555555'

function request(body: unknown = { operation_id: OPERATION_ID }): NextRequest {
  return new NextRequest('http://localhost/api/groups/applications/review', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function context(id = APPLICATION_ID) {
  return { params: Promise.resolve({ id }) }
}

describe('group application review atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyAdmin.mockResolvedValue({ id: REVIEWER_ID, email: 'admin@example.com' })
  })

  it('approves through one reviewer-bound RPC and notifies only after commit', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'approved',
        application_id: APPLICATION_ID,
        applicant_id: APPLICANT_ID,
        group_id: GROUP_ID,
        group_name: 'Atomic Group',
        operation_id: OPERATION_ID,
        applied: true,
      },
      error: null,
    })

    const response = await approve(request(), context())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('review_group_application_atomic', {
      p_reviewer_id: REVIEWER_ID,
      p_application_id: APPLICATION_ID,
      p_decision: 'approve',
      p_reject_reason: null,
      p_promo_unlocked: PRO_FREE_PROMO,
      p_operation_id: OPERATION_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockNotifyNewGroup).toHaveBeenCalledWith(null, 'Atomic Group')
  })

  it('rejects through the same transaction boundary and uses the canonical reason', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'rejected',
        application_id: APPLICATION_ID,
        applicant_id: APPLICANT_ID,
        group_name: 'Atomic Group',
        reject_reason: 'canonical reason',
        operation_id: OPERATION_ID,
        applied: true,
      },
      error: null,
    })

    const response = await reject(
      request({ operation_id: OPERATION_ID, reason: '  submitted reason  ' }),
      context()
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('review_group_application_atomic', {
      p_reviewer_id: REVIEWER_ID,
      p_application_id: APPLICATION_ID,
      p_decision: 'reject',
      p_reject_reason: 'submitted reason',
      p_promo_unlocked: PRO_FREE_PROMO,
      p_operation_id: OPERATION_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockNotifyNewGroup).not.toHaveBeenCalled()
  })

  it('uses Unicode code-point bounds for historical names and rejection reasons', async () => {
    const fiftyEmoji = '😀'.repeat(50)
    const fiveHundredEmoji = '😀'.repeat(500)
    mockRpc.mockResolvedValue({
      data: {
        status: 'rejected',
        application_id: APPLICATION_ID,
        applicant_id: APPLICANT_ID,
        group_name: fiftyEmoji,
        reject_reason: fiveHundredEmoji,
        operation_id: OPERATION_ID,
        applied: true,
      },
      error: null,
    })

    const accepted = await reject(
      request({ operation_id: OPERATION_ID, reason: fiveHundredEmoji }),
      context()
    )
    const rejected = await reject(
      request({ operation_id: OPERATION_ID, reason: '😀'.repeat(501) }),
      context()
    )

    expect(accepted.status).toBe(200)
    expect(rejected.status).toBe(400)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'review_group_application_atomic',
      expect.objectContaining({ p_reject_reason: fiveHundredEmoji })
    )
  })

  it.each([
    [{ data: { status: 'reviewer_unauthorized' }, error: null }, 403],
    [{ data: { status: 'already_processed' }, error: null }, 409],
    [{ data: { status: 'name_taken' }, error: null }, 409],
    [{ data: { status: 'pro_required' }, error: null }, 409],
    [{ data: { status: 'operation_conflict' }, error: null }, 409],
    [{ data: null, error: { code: 'XX000' } }, 500],
    [{ data: null, error: null }, 500],
    [
      {
        data: {
          status: 'approved',
          application_id: APPLICATION_ID,
          applicant_id: APPLICANT_ID,
          group_id: GROUP_ID,
          operation_id: OPERATION_ID,
          applied: true,
        },
        error: null,
      },
      500,
    ],
  ])('fails approval closed for canonical/malformed result %#', async (rpcResult, status) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await approve(request(), context())

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockNotifyNewGroup).not.toHaveBeenCalled()
  })

  it('fails rejection closed when the RPC returns the wrong success variant', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'approved',
        application_id: APPLICATION_ID,
        applicant_id: APPLICANT_ID,
        group_id: GROUP_ID,
        group_name: 'Atomic Group',
        operation_id: OPERATION_ID,
        applied: true,
      },
      error: null,
    })

    const response = await reject(request({ operation_id: OPERATION_ID, reason: 'no' }), context())

    expect(response.status).toBe(500)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockNotifyNewGroup).not.toHaveBeenCalled()
  })

  it('does not repeat the best-effort Telegram alert for a durable replay', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'approved',
        application_id: APPLICATION_ID,
        applicant_id: APPLICANT_ID,
        group_id: GROUP_ID,
        group_name: 'Atomic Group',
        operation_id: OPERATION_ID,
        applied: false,
      },
      error: null,
    })

    const response = await approve(request(), context())

    expect(response.status).toBe(200)
    expect(mockNotifyNewGroup).not.toHaveBeenCalled()
  })

  it('rejects malformed ids and authority-bearing rejection input before the RPC', async () => {
    const invalidIdResponse = await approve(request(), context('not-a-uuid'))
    const injectedBodyResponse = await reject(
      request({ reason: 'no', reviewer_id: APPLICANT_ID }),
      context()
    )
    const malformedJsonResponse = await reject(
      new NextRequest('http://localhost/api/groups/applications/review', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
        body: '{',
      }),
      context()
    )

    expect(invalidIdResponse.status).toBe(400)
    expect(injectedBodyResponse.status).toBe(400)
    expect(malformedJsonResponse.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires operational admin authorization before touching the RPC', async () => {
    mockVerifyAdmin.mockResolvedValue(null)

    const response = await approve(request(), context())

    expect(response.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
