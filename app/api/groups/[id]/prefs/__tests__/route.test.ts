jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockMaybeSingle = jest.fn()
const query = {
  select: jest.fn(() => query),
  update: jest.fn(() => query),
  eq: jest.fn(() => query),
  maybeSingle: mockMaybeSingle,
}
const mockFrom = jest.fn(() => query)
const mockLoggerError = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { from: typeof mockFrom }
        request: { url: string; json: () => Promise<unknown> }
      }) => unknown
    ) =>
    (request: { url: string; json: () => Promise<unknown> }) =>
      handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { from: mockFrom },
        request,
      }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

import { GET, PATCH } from '../route'

const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'

function request(body: unknown = {}, groupId = GROUP_ID) {
  return {
    url: `http://localhost/api/groups/${groupId}/prefs`,
    json: jest.fn().mockResolvedValue(body),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMaybeSingle.mockResolvedValue({
    data: { self_notify_muted: false, pinned: true },
    error: null,
  })
})

describe('/api/groups/[id]/prefs contract', () => {
  it('returns an exact no-store snapshot bound to the viewer and group', async () => {
    const response = await GET(request() as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(Object.keys(body).sort()).toEqual(['data', 'meta', 'success'])
    expect(body).toMatchObject({
      success: true,
      data: {
        preferences: {
          viewer_id: VIEWER_ID,
          group_id: GROUP_ID,
          self_notify_muted: false,
          pinned: true,
        },
      },
      meta: { timestamp: expect.any(String) },
    })
    expect(mockFrom).toHaveBeenCalledWith('group_members')
  })

  it('rejects an invalid group identity before reading membership', async () => {
    const response = await GET(request({}, 'not-a-group') as never)

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { self_notify_muted: null, pinned: true },
    { self_notify_muted: false, pinned: 1 },
    { self_notify_muted: false, pinned: true, extra: true },
  ])('fails closed on an invalid stored preference row %#', async (data) => {
    mockMaybeSingle.mockResolvedValue({ data, error: null })

    const response = await GET(request() as never)

    expect(response.status).toBe(500)
  })

  it.each([
    [{ self_notify_muted: true, pinned: false }, 'multiple fields'],
    [{ self_notify_muted: true, extra: true }, 'unknown field'],
    [{ self_notify_muted: 1 }, 'coerced boolean'],
    [{}, 'empty body'],
    [null, 'null body'],
  ])('rejects %s (%s) before updating', async (body) => {
    const response = await PATCH(request(body) as never)

    expect(response.status).toBe(400)
    expect(query.update).not.toHaveBeenCalled()
  })

  it('returns an exact mutation receipt for the requested desired state', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { self_notify_muted: true, pinned: true },
      error: null,
    })

    const response = await PATCH(request({ self_notify_muted: true }) as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(query.update).toHaveBeenCalledWith({ self_notify_muted: true })
    expect(body).toMatchObject({
      success: true,
      data: {
        preferences: {
          viewer_id: VIEWER_ID,
          group_id: GROUP_ID,
          self_notify_muted: true,
          pinned: true,
        },
        mutation: { field: 'self_notify_muted', value: true },
      },
      meta: { timestamp: expect.any(String) },
    })
  })

  it('does not acknowledge a database row that missed the desired state', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { self_notify_muted: false, pinned: true },
      error: null,
    })

    const response = await PATCH(request({ self_notify_muted: true }) as never)

    expect(response.status).toBe(500)
  })

  it('returns a retryable failure when the membership authority fails', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await PATCH(request({ pinned: false }) as never)

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
