/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const SECOND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockLoggerError = jest.fn()
const mockFeatures = { social: true }
let mockUserId = ACTOR_ID

jest.mock('next/server', () => {
  class MockNextResponse {
    headers: Headers
    status: number

    constructor(
      private readonly body: unknown,
      init: { headers?: HeadersInit; status?: number } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { headers?: HeadersInit; status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: mockUserId },
        supabase: { from: mockFrom, rpc: mockRpc },
        request,
      }),
}))

jest.mock('@/lib/features', () => ({
  features: {
    get social() {
      return mockFeatures.social
    },
  },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
}))

import { GET } from '../route'

function request(parameters: Record<string, string | readonly string[]> = {}) {
  const url = new URL('https://example.com/api/notifications')
  for (const [key, values] of Object.entries(parameters)) {
    for (const value of typeof values === 'string' ? [values] : values) {
      url.searchParams.append(key, value)
    }
  }
  return { url: url.toString() } as never
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: FIRST_ID,
    user_id: ACTOR_ID,
    type: 'system',
    title: 'System notice',
    message: 'Something happened',
    link: '/settings',
    read: false,
    actor_id: OTHER_ID,
    reference_id: null,
    created_at: '2026-07-29T12:00:00.123456+00:00',
    actor_handle: 'alice',
    actor_avatar_url: null,
    ...overrides,
  }
}

function secondNotification(overrides: Record<string, unknown> = {}) {
  return notification({
    id: SECOND_ID,
    title: 'Older notice',
    created_at: '2026-07-29T11:00:00+00:00',
    link: null,
    actor_id: null,
    actor_handle: null,
    actor_avatar_url: null,
    ...overrides,
  })
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    types: null,
    notifications: [notification(), secondNotification()],
    unread_count: 2,
    has_more: false,
    next_cursor: null,
    ...overrides,
  }
}

describe('GET /api/notifications atomic page authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFeatures.social = true
    mockUserId = ACTOR_ID
    mockRpc.mockResolvedValue({ data: acknowledgement(), error: null })
    mockFrom.mockImplementation(() => {
      throw new Error('notification list must not issue direct table reads')
    })
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns one exact private viewer-bound notification snapshot', async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      notifications: [notification(), secondNotification()],
      unread_count: 2,
      next_cursor: null,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('get_notification_page_atomic', {
      p_actor_id: ACTOR_ID,
      p_types: null,
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 20,
    })
  })

  it('binds a filter and both cursor fields into the same RPC', async () => {
    const cursor = '2026-07-29T13:00:00.000001Z'
    const cursorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    mockRpc.mockResolvedValue({
      data: acknowledgement({
        types: ['follow', 'new_follower'],
        notifications: [
          notification({ type: 'new_follower' }),
          secondNotification({ type: 'follow' }),
        ],
      }),
      error: null,
    })

    const response = await GET(
      request({ filter: 'follow', limit: '2', cursor, cursorId: cursorId.toUpperCase() })
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('get_notification_page_atomic', {
      p_actor_id: ACTOR_ID,
      p_types: ['follow', 'new_follower'],
      p_before_created_at: cursor,
      p_before_id: cursorId,
      p_limit: 2,
    })
  })

  it('normalizes the session actor and strips unsafe navigation links', async () => {
    mockUserId = ACTOR_ID.toUpperCase()
    mockRpc.mockResolvedValue({
      data: acknowledgement({
        notifications: [notification({ link: 'javascript:alert(1)' }), secondNotification()],
      }),
      error: null,
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.notifications[0].link).toBeNull()
    expect(mockRpc).toHaveBeenCalledWith(
      'get_notification_page_atomic',
      expect.objectContaining({ p_actor_id: ACTOR_ID })
    )
  })

  it('passes an empty type set when a disabled social surface is requested', async () => {
    mockFeatures.social = false
    mockRpc.mockResolvedValue({
      data: acknowledgement({ types: [], notifications: [], unread_count: 0 }),
      error: null,
    })

    const response = await GET(request({ filter: 'follow' }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'get_notification_page_atomic',
      expect.objectContaining({ p_types: [] })
    )
  })

  it.each([
    [{ offset: '20' }, 'legacy offset'],
    [{ filter: 'reaction' }, 'unknown filter'],
    [{ limit: '0' }, 'zero limit'],
    [{ limit: '51' }, 'oversized limit'],
    [{ limit: '1.5' }, 'fractional limit'],
    [{ cursor: '2026-07-29T12:00:00Z' }, 'half cursor'],
    [{ cursorId: FIRST_ID }, 'other half cursor'],
    [{ cursor: 'later', cursorId: FIRST_ID }, 'malformed cursor'],
    [{ filter: ['all', 'follow'] }, 'duplicate parameter'],
  ])('rejects %s before touching the database (%s)', async (parameters) => {
    const response = await GET(request(parameters))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('maps authoritative actor unavailability to a private denial', async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, reason: 'ACTOR_UNAVAILABLE' },
      error: null,
    })

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'No permission to access notifications',
    })
  })

  it.each([
    ['database failure', { data: null, error: { message: 'database unavailable' } }],
    ['missing acknowledgement', { data: null, error: null }],
    ['extra acknowledgement key', { data: { ...acknowledgement(), stale: true }, error: null }],
    ['wrong actor binding', { data: acknowledgement({ actor_id: OTHER_ID }), error: null }],
    ['wrong type binding', { data: acknowledgement({ types: [] }), error: null }],
    [
      'wrong notification owner',
      {
        data: acknowledgement({
          notifications: [notification({ user_id: OTHER_ID }), secondNotification()],
        }),
        error: null,
      },
    ],
    [
      'duplicate notification',
      { data: acknowledgement({ notifications: [notification(), notification()] }), error: null },
    ],
    [
      'ordering drift',
      {
        data: acknowledgement({ notifications: [secondNotification(), notification()] }),
        error: null,
      },
    ],
    [
      'malformed timestamp',
      {
        data: acknowledgement({ notifications: [notification({ created_at: 'later' })] }),
        error: null,
      },
    ],
    [
      'database precision overflow',
      {
        data: acknowledgement({
          notifications: [notification({ created_at: '2026-07-29T12:00:00.1234567Z' })],
        }),
        error: null,
      },
    ],
    [
      'detached actor detail leak',
      {
        data: acknowledgement({
          notifications: [
            notification({ actor_id: null, actor_handle: 'private', actor_avatar_url: null }),
          ],
        }),
        error: null,
      },
    ],
    [
      'has-more without a full page',
      {
        data: acknowledgement({
          has_more: true,
          next_cursor: {
            before: '2026-07-29T11:00:00+00:00',
            before_id: SECOND_ID,
          },
        }),
        error: null,
      },
    ],
    [
      'cursor not bound to the last row',
      {
        data: acknowledgement({
          has_more: true,
          notifications: Array.from({ length: 20 }, (_, index) =>
            notification({
              id: `aaaaaaaa-aaaa-4aaa-8aaa-${(100000000000 + index).toString()}`,
              created_at: `2026-07-29T10:${(59 - index).toString().padStart(2, '0')}:00Z`,
            })
          ),
          next_cursor: {
            before: '2026-07-29T10:40:00Z',
            before_id: FIRST_ID,
          },
        }),
        error: null,
      },
    ],
    [
      'unsafe unread integer',
      { data: acknowledgement({ unread_count: Number.MAX_SAFE_INTEGER + 1 }), error: null },
    ],
    [
      'impossible invalid request ACK',
      { data: { success: false, reason: 'INVALID' }, error: null },
    ],
    [
      'persisted data-integrity failure',
      { data: { success: false, reason: 'DATA_INTEGRITY' }, error: null },
    ],
  ])('fails closed on %s without a table-read fallback', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch notifications' })
  })

  it('fails closed before the RPC when the authenticated actor is malformed', async () => {
    mockUserId = 'not-an-actor'

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('contains no cache, offset, data-layer, or table-read fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/notifications/route.ts'), 'utf8')
    const getSource = source.slice(
      source.indexOf('export const GET'),
      source.indexOf('export const PUT')
    )

    expect(getSource).toContain("'get_notification_page_atomic'")
    expect(getSource).not.toContain('.from(')
    expect(getSource).not.toContain('getOrSet')
    expect(getSource).not.toContain('getUserNotificationsWithCount')
    expect(getSource).not.toContain('offset')
  })
})
