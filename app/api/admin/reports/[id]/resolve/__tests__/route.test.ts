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
    headers: Map<string, string>
    private body: unknown
    constructor(
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
    ) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.body = init.body
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }
    async json() {
      if (this.body instanceof Error) throw this.body
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockVerifyAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()

jest.mock('@/lib/admin/auth', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
  verifyAdmin: (...args: unknown[]) => mockVerifyAdmin(...args),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { sensitive: { limit: 5 } },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import { NextRequest, NextResponse } from 'next/server'
import { POST } from '../route'

const REPORT_ID = '30000000-0000-4000-8000-000000000001'
const CONTENT_ID = '20000000-0000-4000-8000-000000000001'
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOG_ID = '40000000-0000-4000-8000-000000000001'

type RequestInput = {
  id?: string
  body?: unknown
}

function request(input: RequestInput = {}) {
  const body = Object.prototype.hasOwnProperty.call(input, 'body')
    ? input.body
    : { action: 'resolve' }
  return {
    req: new NextRequest(`http://localhost/api/admin/reports/${input.id ?? REPORT_ID}/resolve`, {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body,
    }),
    params: Promise.resolve({ id: input.id ?? REPORT_ID }),
  }
}

function appliedResult(overrides: Record<string, unknown> = {}) {
  return [
    {
      applied: true,
      result_action: 'resolve',
      result_code: 'applied',
      report_id: REPORT_ID,
      report_status: 'resolved',
      content_type: 'comment',
      content_id: CONTENT_ID,
      action_taken: 'content_deleted',
      content_soft_deleted: true,
      content_affected_count: 2,
      admin_log_id: LOG_ID,
      ...overrides,
    },
  ]
}

async function run(input: RequestInput = {}) {
  const context = request(input)
  return POST(context.req, { params: context.params })
}

describe('POST /api/admin/reports/[id]/resolve atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyAdmin.mockResolvedValue({ id: ADMIN_ID, email: 'admin@example.com' })
    mockCheckRateLimit.mockResolvedValue(null)
    mockRpc.mockResolvedValue({ data: appliedResult(), error: null })
  })

  it('delegates one trimmed resolution to the strict atomic RPC', async () => {
    const response = await run({ body: { action: 'resolve', reason: '  confirmed abuse  ' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      applied: true,
      result: 'applied',
      action_taken: 'content_deleted',
      content_affected_count: 2,
      report: {
        id: REPORT_ID,
        status: 'resolved',
        content_type: 'comment',
        content_id: CONTENT_ID,
      },
    })
    expect(mockRpc).toHaveBeenCalledWith('resolve_content_report_atomic', {
      p_actor_id: ADMIN_ID,
      p_report_id: REPORT_ID,
      p_action: 'resolve',
      p_reason: 'confirmed abuse',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps the legacy no-reason caller compatible', async () => {
    const response = await run({ body: { action: 'resolve' } })

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'resolve_content_report_atomic',
      expect.objectContaining({ p_reason: null })
    )
  })

  it('accepts an exact physical-absence acknowledgement without claiming an affected row', async () => {
    mockRpc.mockResolvedValue({
      data: appliedResult({
        content_type: 'post',
        action_taken: 'content_already_absent',
        content_soft_deleted: null,
        content_affected_count: 0,
      }),
      error: null,
    })

    const response = await run()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      action_taken: 'content_already_absent',
      content_affected_count: 0,
      message: 'Report resolved; content was already absent',
    })
  })

  it('dismisses a non-content target without inventing a delete effect', async () => {
    mockRpc.mockResolvedValue({
      data: appliedResult({
        result_action: 'dismiss',
        report_status: 'dismissed',
        content_type: 'user',
        action_taken: 'dismissed',
        content_soft_deleted: null,
        content_affected_count: 0,
      }),
      error: null,
    })

    const response = await run({ body: { action: 'dismiss' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, action_taken: 'dismissed' })
  })

  it('returns an idempotent success when the report was already processed', async () => {
    mockRpc.mockResolvedValue({
      data: appliedResult({
        applied: false,
        result_code: 'already_processed',
        action_taken: 'content_deleted',
        content_soft_deleted: true,
        content_affected_count: 0,
        admin_log_id: LOG_ID,
      }),
      error: null,
    })

    const response = await run()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      applied: false,
      result: 'already_processed',
    })
  })

  it('accepts queue approval as an equivalent dismiss retry', async () => {
    mockRpc.mockResolvedValue({
      data: appliedResult({
        applied: false,
        result_action: 'dismiss',
        result_code: 'already_processed',
        report_status: 'dismissed',
        action_taken: 'approved_content',
        content_soft_deleted: null,
        content_affected_count: 0,
        admin_log_id: LOG_ID,
      }),
      error: null,
    })

    const response = await run({ body: { action: 'dismiss' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, applied: false })
  })

  it.each([
    [
      'dismissed report requested as resolve',
      appliedResult({
        applied: false,
        result_code: 'already_processed',
        report_status: 'dismissed',
        action_taken: 'dismissed',
        content_soft_deleted: null,
        content_affected_count: 0,
        admin_log_id: LOG_ID,
      }),
    ],
    [
      'queue warning requested as resolve',
      appliedResult({
        applied: false,
        result_code: 'already_processed',
        action_taken: 'user_warned',
        content_soft_deleted: null,
        content_affected_count: 0,
        admin_log_id: LOG_ID,
      }),
    ],
    [
      'processed message forged as a deleted resolution',
      appliedResult({
        applied: false,
        result_code: 'already_processed',
        content_type: 'message',
        action_taken: 'content_already_absent',
        content_soft_deleted: null,
        content_affected_count: 0,
        admin_log_id: LOG_ID,
      }),
    ],
    [
      'resolved report requested as dismiss',
      appliedResult({
        applied: false,
        result_action: 'dismiss',
        result_code: 'already_processed',
        action_taken: 'content_deleted',
        content_soft_deleted: null,
        content_affected_count: 0,
        admin_log_id: LOG_ID,
      }),
    ],
  ])('fails closed on non-equivalent no-op: %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const action = data[0].result_action as 'resolve' | 'dismiss'
    const response = await run({ body: { action } })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'INVALID_ACK' })
  })

  it.each([
    ['extra acknowledgement key', appliedResult({ unexpected: true })],
    ['wrong report binding', appliedResult({ report_id: '30000000-0000-4000-8000-000000000002' })],
    ['delete effect with zero rows', appliedResult({ content_affected_count: 0 })],
    [
      'missing-content effect with a false soft-delete flag',
      appliedResult({
        action_taken: 'content_already_absent',
        content_soft_deleted: false,
        content_affected_count: 0,
      }),
    ],
    ['resolve effect for unsupported content', appliedResult({ content_type: 'message' })],
    ['missing audit acknowledgement', appliedResult({ admin_log_id: null })],
    [
      'missing retry audit acknowledgement',
      appliedResult({
        applied: false,
        result_code: 'already_processed',
        content_affected_count: 0,
        admin_log_id: null,
      }),
    ],
    ['more than one result row', [...appliedResult(), ...appliedResult()]],
  ])('fails closed on %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await run()

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'INVALID_ACK' })
  })

  it.each([
    ['P0002', 404, 'REPORT_NOT_FOUND'],
    ['22023', 400, 'INVALID_INPUT'],
    ['42501', 403, 'FORBIDDEN'],
    ['0A000', 422, 'UNSUPPORTED_CONTENT'],
    ['40001', 409, 'MODERATION_CONFLICT'],
    ['40P01', 409, 'MODERATION_CONFLICT'],
    ['55P03', 409, 'MODERATION_CONFLICT'],
    ['XX001', 500, 'DATABASE_ERROR'],
  ])(
    'maps database code %s without falling back to direct writes',
    async (code, status, apiCode) => {
      mockRpc.mockResolvedValue({ data: null, error: { code } })

      const response = await run()

      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code: apiCode })
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['not-a-uuid', { action: 'resolve' }],
    [REPORT_ID, null],
    [REPORT_ID, []],
    [REPORT_ID, { action: 'approve' }],
    [REPORT_ID, { action: 'resolve', reason: null }],
    [REPORT_ID, { action: 'resolve', reason: 7 }],
    [REPORT_ID, { action: 'resolve', reason: 'x'.repeat(501) }],
    [REPORT_ID, { action: 'resolve', extra: true }],
  ])('rejects invalid input before RPC (%s)', async (id, body) => {
    const response = await run({ id, body })

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('counts Unicode reason length the same way PostgreSQL char_length does', async () => {
    const reason = '🙂'.repeat(500)
    const response = await run({ body: { action: 'resolve', reason } })

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'resolve_content_report_atomic',
      expect.objectContaining({ p_reason: reason })
    )
  })

  it.each([undefined, '', '   '])(
    'canonicalizes optional/blank reason %p to null',
    async (reason) => {
      const body = reason === undefined ? { action: 'resolve' } : { action: 'resolve', reason }
      const response = await run({ body })

      expect(response.status).toBe(200)
      expect(mockRpc).toHaveBeenCalledWith(
        'resolve_content_report_atomic',
        expect.objectContaining({ p_reason: null })
      )
    }
  )

  it('canonicalizes an uppercase UUID before binding the RPC acknowledgement', async () => {
    const response = await run({ id: REPORT_ID.toUpperCase() })

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'resolve_content_report_atomic',
      expect.objectContaining({ p_report_id: REPORT_ID })
    )
  })

  it('rejects malformed JSON before RPC', async () => {
    const response = await run({ body: new Error('bad json') })

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('preserves the authentication and fail-closed rate-limit gates', async () => {
    const limited = NextResponse.json({ error: 'limited' }, { status: 429 })
    mockCheckRateLimit.mockResolvedValueOnce(limited)
    const limitedResponse = await run()
    expect(limitedResponse.status).toBe(429)
    expect(mockVerifyAdmin).not.toHaveBeenCalled()

    mockCheckRateLimit.mockResolvedValueOnce(null)
    mockVerifyAdmin.mockResolvedValueOnce(null)
    const unauthorizedResponse = await run()
    expect(unauthorizedResponse.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
