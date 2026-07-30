/** @jest-environment node */

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockLoggerError = jest.fn()
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
jest.mock('@/lib/features', () => ({ features: { social: true } }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
}))

import { DELETE, PUT } from '../route'
import { POST as LEGACY_POST } from '../mark-read/route'

type Action = 'MARK_READ' | 'MARK_ALL_READ' | 'DELETE'

function request(body: unknown, validJson = true) {
  return {
    url: 'https://example.com/api/notifications',
    json: validJson ? jest.fn().mockResolvedValue(body) : jest.fn().mockRejectedValue(new Error()),
  } as never
}

function acknowledgement(
  action: Action,
  notificationIds: string[] | null,
  overrides: Record<string, unknown> = {}
) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    action,
    notification_ids: notificationIds,
    changed_count: action === 'DELETE' ? 1 : 0,
    mutation_at: '2026-07-29T12:00:00.123456+00:00',
    ...overrides,
  }
}

describe('notification atomic mutation routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUserId = ACTOR_ID
    mockFrom.mockImplementation(() => {
      throw new Error('notification mutations must not issue direct table writes')
    })
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('binds one normalized notification ID into MARK_READ', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement('MARK_READ', [FIRST_ID], { changed_count: 1 }),
      error: null,
    })

    const response = await PUT(request({ notification_id: FIRST_ID.toUpperCase() }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('mutate_notifications_atomic', {
      p_actor_id: ACTOR_ID,
      p_action: 'MARK_READ',
      p_notification_ids: [FIRST_ID],
    })
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        message: 'Marked as read',
        actor_id: ACTOR_ID,
        action: 'MARK_READ',
        notification_ids: [FIRST_ID],
        changed_count: 1,
        mutation_at: '2026-07-29T12:00:00.123456+00:00',
      },
    })
  })

  it('preserves one exact normalized batch and accepts an idempotent replay', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement('MARK_READ', [SECOND_ID, FIRST_ID]),
      error: null,
    })

    const response = await PUT(
      request({ notification_ids: [SECOND_ID.toUpperCase(), FIRST_ID.toUpperCase()] })
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('mutate_notifications_atomic', {
      p_actor_id: ACTOR_ID,
      p_action: 'MARK_READ',
      p_notification_ids: [SECOND_ID, FIRST_ID],
    })
  })

  it('uses a null target set for MARK_ALL_READ', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement('MARK_ALL_READ', null, { changed_count: 42 }),
      error: null,
    })

    const response = await PUT(request({ mark_all: true }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('mutate_notifications_atomic', {
      p_actor_id: ACTOR_ID,
      p_action: 'MARK_ALL_READ',
      p_notification_ids: null,
    })
  })

  it('requires an exact owned delete acknowledgement', async () => {
    mockRpc.mockResolvedValue({ data: acknowledgement('DELETE', [FIRST_ID]), error: null })

    const response = await DELETE(request({ notification_id: FIRST_ID }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('mutate_notifications_atomic', {
      p_actor_id: ACTOR_ID,
      p_action: 'DELETE',
      p_notification_ids: [FIRST_ID],
    })
  })

  it('keeps the legacy POST path on the same canonical handler', () => {
    expect(LEGACY_POST).toBe(PUT)
  })

  it.each([
    [{}, 'missing mode'],
    [{ mark_all: false }, 'false mark-all'],
    [{ mark_all: true, notification_id: FIRST_ID }, 'mixed modes'],
    [{ notification_id: FIRST_ID, extra: true }, 'unknown field'],
    [{ notification_id: 'not-a-uuid' }, 'malformed ID'],
    [{ notification_ids: [] }, 'empty batch'],
    [{ notification_ids: [FIRST_ID, FIRST_ID.toUpperCase()] }, 'normalized duplicate'],
    [{ notification_ids: [FIRST_ID, 7] }, 'non-string batch member'],
    [
      {
        notification_ids: Array.from(
          { length: 101 },
          (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${(100000000000 + index).toString()}`
        ),
      },
      'oversized batch',
    ],
  ])('rejects %s before the database (%s)', async (body) => {
    const response = await PUT(request(body))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before the database', async () => {
    const response = await PUT(request(null, false))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps DELETE strict and UUID-bound', async () => {
    for (const body of [
      {},
      { notification_id: 'bad' },
      { notification_id: FIRST_ID, extra: true },
    ]) {
      const response = await DELETE(request(body))
      expect(response.status).toBe(400)
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['actor unavailable', { success: false, reason: 'ACTOR_UNAVAILABLE' }, 403],
    ['missing or foreign target', { success: false, reason: 'NOT_FOUND' }, 404],
    ['impossible invalid request', { success: false, reason: 'INVALID' }, 500],
  ])('maps %s without claiming success', async (_label, data, status) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await PUT(request({ notification_id: FIRST_ID }))

    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it.each([
    ['missing acknowledgement', null],
    ['extra acknowledgement key', { ...acknowledgement('MARK_READ', [FIRST_ID]), stale: true }],
    ['wrong actor', acknowledgement('MARK_READ', [FIRST_ID], { actor_id: OTHER_ID })],
    ['wrong action', acknowledgement('DELETE', [FIRST_ID])],
    ['wrong target order', acknowledgement('MARK_READ', [SECOND_ID, FIRST_ID])],
    ['null target set', acknowledgement('MARK_READ', null)],
    ['too many transitions', acknowledgement('MARK_READ', [FIRST_ID], { changed_count: 2 })],
    [
      'unsafe transition count',
      acknowledgement('MARK_READ', [FIRST_ID], {
        changed_count: Number.MAX_SAFE_INTEGER + 1,
      }),
    ],
    ['malformed mutation time', acknowledgement('MARK_READ', [FIRST_ID], { mutation_at: 'later' })],
  ])('fails closed on %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await PUT(request({ notification_id: FIRST_ID }))

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('fails closed when a delete acknowledgement did not delete exactly one row', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement('DELETE', [FIRST_ID], { changed_count: 0 }),
      error: null,
    })

    const response = await DELETE(request({ notification_id: FIRST_ID }))

    expect(response.status).toBe(500)
  })

  it('fails closed on an RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await PUT(request({ mark_all: true }))

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('normalizes the authenticated actor and rejects a malformed principal', async () => {
    mockUserId = ACTOR_ID.toUpperCase()
    mockRpc.mockResolvedValue({ data: acknowledgement('MARK_ALL_READ', null), error: null })

    expect((await PUT(request({ mark_all: true }))).status).toBe(200)
    expect(mockRpc).toHaveBeenLastCalledWith(
      'mutate_notifications_atomic',
      expect.objectContaining({ p_actor_id: ACTOR_ID })
    )

    jest.clearAllMocks()
    mockUserId = 'not-an-actor'
    expect((await PUT(request({ mark_all: true }))).status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
