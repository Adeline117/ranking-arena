import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockVerifyAdmin = jest.fn()
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
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST as approve } from '../approve/route'
import { POST as reject } from '../reject/route'

const REVIEWER_ID = '11111111-1111-4111-8111-111111111111'
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222'
const APPLICANT_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REVIEWED_AT = '2026-07-16T17:00:00.000Z'

function request(body: unknown = { operation_id: OPERATION_ID }): NextRequest {
  return new NextRequest('http://localhost/api/groups/edit-applications/review', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify(body),
  })
}

function rawRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost/api/groups/edit-applications/review', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-token' },
    body: rawBody,
  })
}

function context(id = APPLICATION_ID) {
  return { params: Promise.resolve({ id }) }
}

function approvedResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'approved',
    operation_id: OPERATION_ID,
    application_id: APPLICATION_ID,
    applicant_id: APPLICANT_ID,
    group_id: GROUP_ID,
    group_name: 'Atomic Group',
    reviewed_at: REVIEWED_AT,
    applied: true,
    ...overrides,
  }
}

function rejectedResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'rejected',
    operation_id: OPERATION_ID,
    application_id: APPLICATION_ID,
    applicant_id: APPLICANT_ID,
    group_id: GROUP_ID,
    group_name: 'Atomic Group',
    reject_reason: 'canonical reason',
    reviewed_at: REVIEWED_AT,
    applied: true,
    ...overrides,
  }
}

describe('group edit application review atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyAdmin.mockResolvedValue({ id: REVIEWER_ID, email: 'admin@example.com' })
  })

  it('approves through exactly one reviewer/application/operation-bound RPC', async () => {
    mockRpc.mockResolvedValue({ data: approvedResult(), error: null })

    const response = await approve(request({ operation_id: OPERATION_ID.toUpperCase() }), context())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('review_group_edit_application_atomic', {
      p_reviewer_id: REVIEWER_ID,
      p_application_id: APPLICATION_ID,
      p_decision: 'approve',
      p_reject_reason: null,
      p_operation_id: OPERATION_ID,
    })
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Edit application approved',
      operation_id: OPERATION_ID,
      application: { id: APPLICATION_ID, group_id: GROUP_ID, status: 'approved' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects through the same RPC with a normalized optional reason', async () => {
    mockRpc.mockResolvedValue({ data: rejectedResult(), error: null })

    const response = await reject(
      request({ operation_id: OPERATION_ID, reason: '  canonical reason  ' }),
      context()
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('review_group_edit_application_atomic', {
      p_reviewer_id: REVIEWER_ID,
      p_application_id: APPLICATION_ID,
      p_decision: 'reject',
      p_reject_reason: 'canonical reason',
      p_operation_id: OPERATION_ID,
    })
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Edit application rejected',
      operation_id: OPERATION_ID,
      application: {
        id: APPLICATION_ID,
        group_id: GROUP_ID,
        status: 'rejected',
        reject_reason: 'canonical reason',
      },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [true, approve, approvedResult()],
    [false, approve, approvedResult({ applied: false })],
  ])(
    'does not expose applied=%s in an approval acknowledgement',
    async (_applied, route, result) => {
      mockRpc.mockResolvedValue({ data: result, error: null })

      const response = await route(request(), context())
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(200)
      expect(body).not.toHaveProperty('applied')
    }
  )

  it('returns byte-for-byte-equivalent public ACK data for fresh and replayed reviews', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: approvedResult({ applied: true }), error: null })
      .mockResolvedValueOnce({ data: approvedResult({ applied: false }), error: null })
      .mockResolvedValueOnce({ data: rejectedResult({ applied: true }), error: null })
      .mockResolvedValueOnce({ data: rejectedResult({ applied: false }), error: null })

    const freshApproval = await approve(request(), context())
    const replayApproval = await approve(request(), context())
    const rejectionRequest = () =>
      request({ operation_id: OPERATION_ID, reason: 'canonical reason' })
    const freshRejection = await reject(rejectionRequest(), context())
    const replayRejection = await reject(rejectionRequest(), context())

    await expect(freshApproval.json()).resolves.toEqual(await replayApproval.json())
    await expect(freshRejection.json()).resolves.toEqual(await replayRejection.json())
  })

  it.each([
    ['invalid', 400],
    ['reviewer_inactive', 403],
    ['reviewer_unauthorized', 403],
    ['not_found', 404],
    ['already_processed', 409],
    ['dissolved', 409],
    ['owner_changed', 409],
    ['account_inactive', 409],
    ['premium_change_unsupported', 409],
    ['name_taken', 409],
    ['operation_conflict', 409],
  ])('maps canonical review status %s', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await approve(request(), context())

    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: 'XX000' } },
    { data: null, error: null },
    { data: approvedResult({ attacker_field: true }), error: null },
    {
      data: approvedResult({ operation_id: '66666666-6666-4666-8666-666666666666' }),
      error: null,
    },
    {
      data: approvedResult({ application_id: '66666666-6666-4666-8666-666666666666' }),
      error: null,
    },
    { data: approvedResult({ group_id: 'NOT-A-UUID' }), error: null },
    { data: rejectedResult(), error: null },
  ])('fails approval closed for RPC/malformed/mismatched evidence %#', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await approve(request(), context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails rejection closed for the wrong decision or noncanonical reason evidence', async () => {
    mockRpc.mockResolvedValueOnce({ data: approvedResult(), error: null }).mockResolvedValueOnce({
      data: rejectedResult({ reject_reason: 'different reason' }),
      error: null,
    })

    const wrongDecision = await reject(
      request({ operation_id: OPERATION_ID, reason: 'canonical reason' }),
      context()
    )
    const wrongReason = await reject(
      request({ operation_id: OPERATION_ID, reason: 'canonical reason' }),
      context()
    )

    expect(wrongDecision.status).toBe(500)
    expect(wrongReason.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects bad path/body/JSON and authority-bearing keys before the RPC', async () => {
    const responses = await Promise.all([
      approve(request(), context('not-a-uuid')),
      approve(rawRequest('{'), context()),
      approve(request({}), context()),
      approve(request({ operation_id: OPERATION_ID, reviewer_id: REVIEWER_ID }), context()),
      reject(request({ operation_id: OPERATION_ID, decision: 'approve' }), context()),
      reject(request({ operation_id: OPERATION_ID, reason: '😀'.repeat(501) }), context()),
      reject(request({ operation_id: OPERATION_ID, reason: 'nul\u0000byte' }), context()),
      reject(request({ operation_id: OPERATION_ID, reason: '\ud800' }), context()),
      reject(request({ operation_id: OPERATION_ID, reason: '\udc00' }), context()),
    ])

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400, 400, 400, 400,
    ])
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('requires operational admin authorization before parsing or calling RPC', async () => {
    mockVerifyAdmin.mockResolvedValue(null)

    const response = await approve(request(), context())

    expect(response.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps both review routes RPC-only with no route-level notification', () => {
    for (const routePath of [
      'app/api/groups/edit-applications/[id]/approve/route.ts',
      'app/api/groups/edit-applications/[id]/reject/route.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), routePath), 'utf8')
      expect(source).toContain("'review_group_edit_application_atomic'")
      expect(source).not.toContain('.from(')
      expect(source).not.toContain('.insert(')
      expect(source).not.toContain('.update(')
      expect(source).not.toContain('.delete(')
      expect(source).not.toContain('sendNotification')
    }
  })
})
