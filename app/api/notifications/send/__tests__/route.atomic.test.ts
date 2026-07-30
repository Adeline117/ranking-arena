/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const RECIPIENT_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const NOTIFICATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockDeliverNotification = jest.fn()
const mockVerifyServiceAuth = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockHandleError = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/data/notifications', () => {
  class NotificationDeliveryError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    deliverNotification: (...args: unknown[]) => mockDeliverNotification(...args),
    NotificationDeliveryError,
  }
})
jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyServiceAuth: (...args: unknown[]) => mockVerifyServiceAuth(...args),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  handleError: (...args: unknown[]) => mockHandleError(...args),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

import { POST } from '../route'
import { NotificationDeliveryError } from '@/lib/data/notifications'

function request(body: unknown, validJson = true) {
  return {
    headers: new Headers(),
    json: validJson ? jest.fn().mockResolvedValue(body) : jest.fn().mockRejectedValue(new Error()),
  } as never
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    user_id: RECIPIENT_ID,
    type: 'like',
    title: 'Actor liked your post',
    message: 'A post was liked',
    link: '/post/1',
    actor_id: ACTOR_ID,
    reference_id: 'post-1',
    ...overrides,
  }
}

describe('POST /api/notifications/send atomic authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockVerifyServiceAuth.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue({ authority: 'service' })
    mockDeliverNotification.mockResolvedValue({
      outcome: 'CREATED',
      notificationId: NOTIFICATION_ID,
      createdAt: '2026-07-29T12:00:00Z',
      created: true,
      deduplicated: false,
      skippedSelf: false,
    })
    mockHandleError.mockImplementation(() =>
      Response.json({ error: 'Internal error' }, { status: 500 })
    )
  })

  it('waits for one strict service-authorized create result', async () => {
    const response = await POST(request(body()))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockDeliverNotification).toHaveBeenCalledTimes(1)
    expect(mockDeliverNotification).toHaveBeenCalledWith(
      { authority: 'service' },
      {
        user_id: RECIPIENT_ID,
        type: 'like',
        title: 'Actor liked your post',
        message: 'A post was liked',
        link: '/post/1',
        actor_id: ACTOR_ID,
        reference_id: 'post-1',
      },
      { deduplicate: false }
    )
    await expect(response.json()).resolves.toEqual({
      success: true,
      notification_id: NOTIFICATION_ID,
      outcome: 'CREATED',
      created: true,
      deduplicated: false,
      skipped: false,
    })
  })

  it('binds an explicit dedup window for a service replay', async () => {
    mockDeliverNotification.mockResolvedValue({
      outcome: 'DEDUPLICATED',
      notificationId: NOTIFICATION_ID,
      createdAt: '2026-07-29T12:00:00Z',
      created: false,
      deduplicated: true,
      skippedSelf: false,
    })

    const response = await POST(request(body({ deduplicate: true, dedup_window_seconds: 7200 })))

    expect(response.status).toBe(200)
    expect(mockDeliverNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reference_id: 'post-1' }),
      { deduplicate: true, dedupWindowSeconds: 7200 }
    )
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'DEDUPLICATED',
      created: false,
      deduplicated: true,
    })
  })

  it('returns a real self-skip acknowledgement without an insert ID', async () => {
    mockDeliverNotification.mockResolvedValue({
      outcome: 'SKIPPED_SELF',
      notificationId: null,
      createdAt: null,
      created: false,
      deduplicated: false,
      skippedSelf: true,
    })

    const response = await POST(request(body({ actor_id: RECIPIENT_ID })))

    await expect(response.json()).resolves.toMatchObject({
      notification_id: null,
      outcome: 'SKIPPED_SELF',
      skipped: true,
    })
  })

  it('rejects a caller without service authority before parsing or writing', async () => {
    mockVerifyServiceAuth.mockReturnValue(false)
    const req = request(body())

    const response = await POST(req)

    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(req.json).not.toHaveBeenCalled()
    expect(mockDeliverNotification).not.toHaveBeenCalled()
  })

  it('returns a rate-limit response before any authority work', async () => {
    mockCheckRateLimit.mockResolvedValue(Response.json({ error: 'limited' }, { status: 429 }))

    const response = await POST(request(body()))

    expect(response.status).toBe(429)
    expect(mockVerifyServiceAuth).not.toHaveBeenCalled()
    expect(mockDeliverNotification).not.toHaveBeenCalled()
  })

  it.each([
    [{}, 'missing fields'],
    [body({ user_id: 'bad' }), 'malformed recipient'],
    [body({ actor_id: 'bad' }), 'malformed actor'],
    [body({ type: 'tip_received' }), 'unreviewed generic type'],
    [body({ title: ' ' }), 'blank title'],
    [body({ title: 'x'.repeat(201) }), 'oversized title'],
    [body({ message: 'x'.repeat(1001) }), 'oversized message'],
    [body({ link: 'https://evil.example' }), 'external link'],
    [body({ link: '//evil.example' }), 'protocol-relative link'],
    [body({ deduplicate: true, reference_id: undefined }), 'dedup without identity'],
    [body({ dedup_window_seconds: 60 }), 'window without dedup'],
    [body({ deduplicate: true, dedup_window_seconds: 604801 }), 'oversized window'],
    [body({ extra: true }), 'unknown field'],
  ])('rejects invalid input before delivery (%s)', async (rawBody) => {
    const response = await POST(request(rawBody))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockDeliverNotification).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before delivery', async () => {
    const response = await POST(request(null, false))

    expect(response.status).toBe(400)
    expect(mockDeliverNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['RECIPIENT_UNAVAILABLE', 404],
    ['ACTOR_UNAVAILABLE', 400],
  ])('maps %s without claiming a notification was sent', async (code, status) => {
    mockDeliverNotification.mockRejectedValue(new NotificationDeliveryError(code as never, code))

    const response = await POST(request(body()))

    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('fails closed on an unavailable atomic authority', async () => {
    mockDeliverNotification.mockRejectedValue(
      new NotificationDeliveryError('RPC_ERROR', 'unavailable')
    )

    const response = await POST(request(body()))

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockHandleError).not.toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('contains no raw notification insert fallback', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/api/notifications/send/route.ts'),
      'utf8'
    )

    expect(source).toContain('deliverNotification(')
    expect(source).not.toContain(".from('notifications')")
    expect(source).not.toContain('.insert(')
  })
})
