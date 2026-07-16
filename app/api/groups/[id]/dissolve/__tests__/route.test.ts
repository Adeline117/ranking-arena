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
    constructor(url: string, init: { method?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockFeatureGuard = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { rpc: typeof mockRpc; from: typeof mockFrom }
      }) => unknown
    ) =>
    () =>
      handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { rpc: mockRpc, from: mockFrom },
      }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => mockFeatureGuard() }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest, NextResponse } from 'next/server'
import { POST } from '../route'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const AUDIT_ID = '33333333-3333-4333-8333-333333333333'
const DISSOLVED_AT = '2026-07-16T17:50:00.000+00:00'

function request() {
  return new NextRequest(`http://localhost/api/groups/${GROUP_ID}/dissolve`, {
    method: 'POST',
  })
}

function context(id = GROUP_ID) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/groups/[id]/dissolve', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFeatureGuard.mockReturnValue(null)
    mockRpc.mockResolvedValue({
      data: {
        status: 'dissolved',
        dissolved_at: DISSOLVED_AT,
        audit_log_id: AUDIT_ID,
      },
      error: null,
    })
  })

  it('binds the authenticated owner and performs one canonical RPC', async () => {
    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      action: 'dissolved',
      dissolved_at: DISSOLVED_AT,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('dissolve_group_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('treats an already-dissolved owner retry as an idempotent success', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'already_dissolved', dissolved_at: DISSOLVED_AT },
      error: null,
    })

    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      action: 'already_dissolved',
      dissolved_at: DISSOLVED_AT,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 400, 'Invalid dissolution request'],
    ['actor_unavailable', 403, 'Account is not active'],
    ['not_found', 404, 'Group not found'],
    ['forbidden', 403, 'Only the group owner can dissolve the group'],
  ])('maps canonical %s without a direct table fallback', async (status, code, error) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request(), context())

    expect(response.status).toBe(code)
    expect(await response.json()).toEqual({ error })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects an invalid group id before calling the RPC', async () => {
    const response = await POST(request(), context('not-a-uuid'))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid group id' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('honors the social feature guard before parsing or mutation', async () => {
    const guarded = NextResponse.json({ error: 'Social features unavailable' }, { status: 503 })
    mockFeatureGuard.mockReturnValue(guarded)

    const response = await POST(request(), context('not-a-uuid'))

    expect(response).toBe(guarded)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the canonical RPC fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XX001', message: 'failed' } })

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { status: 'unknown' },
    { status: 'already_dissolved', dissolved_at: 'not-a-date' },
    { status: 'dissolved', dissolved_at: DISSOLVED_AT },
    { status: 'dissolved', dissolved_at: DISSOLVED_AT, audit_log_id: 'not-a-uuid' },
    {
      status: 'dissolved',
      dissolved_at: DISSOLVED_AT,
      audit_log_id: AUDIT_ID,
      forged: true,
    },
  ])('fails closed on malformed RPC data %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
