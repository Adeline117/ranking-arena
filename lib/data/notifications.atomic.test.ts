import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const RECIPIENT_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const NOTIFICATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockFireAndForget = jest.fn()

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))

import {
  createNotificationDeduped,
  deliverNotification,
  NotificationDeliveryError,
  sendNotification,
  sendNotifications,
} from './notifications'

const supabase = { rpc: mockRpc, from: mockFrom } as never

function input(overrides: Record<string, unknown> = {}) {
  return {
    user_id: RECIPIENT_ID,
    type: 'like' as const,
    title: 'Actor liked your post',
    message: 'A post was liked',
    link: '/post/1',
    actor_id: ACTOR_ID,
    reference_id: 'post-1',
    ...overrides,
  }
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    outcome: 'CREATED',
    recipient_id: RECIPIENT_ID,
    type: 'like',
    title: 'Actor liked your post',
    message: 'A post was liked',
    link: '/post/1',
    actor_id: ACTOR_ID,
    reference_id: 'post-1',
    deduplicate: true,
    dedup_window_seconds: 3600,
    notification_id: NOTIFICATION_ID,
    created_at: '2026-07-29T12:00:00.123456+00:00',
    ...overrides,
  }
}

describe('atomic notification delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: acknowledgement(), error: null })
    mockFrom.mockImplementation(() => {
      throw new Error('notification delivery must not read or insert the table directly')
    })
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('waits for one exact created acknowledgement', async () => {
    await expect(deliverNotification(supabase, input())).resolves.toEqual({
      outcome: 'CREATED',
      notificationId: NOTIFICATION_ID,
      createdAt: '2026-07-29T12:00:00.123456+00:00',
      created: true,
      deduplicated: false,
      skippedSelf: false,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('create_notification_atomic', {
      p_recipient_id: RECIPIENT_ID,
      p_type: 'like',
      p_title: 'Actor liked your post',
      p_message: 'A post was liked',
      p_link: '/post/1',
      p_actor_id: ACTOR_ID,
      p_reference_id: 'post-1',
      p_deduplicate: true,
      p_dedup_window_seconds: 3600,
    })
  })

  it('normalizes UUIDs before binding the authority call', async () => {
    await deliverNotification(
      supabase,
      input({ user_id: RECIPIENT_ID.toUpperCase(), actor_id: ACTOR_ID.toUpperCase() })
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'create_notification_atomic',
      expect.objectContaining({ p_recipient_id: RECIPIENT_ID, p_actor_id: ACTOR_ID })
    )
  })

  it('preserves the old default and does not deduplicate a NULL-actor event', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement({
        type: 'system',
        title: 'System notice',
        message: 'Body',
        link: null,
        actor_id: null,
        reference_id: 'system-1',
        deduplicate: false,
        dedup_window_seconds: 0,
      }),
      error: null,
    })

    await deliverNotification(
      supabase,
      input({
        type: 'system',
        title: 'System notice',
        message: 'Body',
        link: undefined,
        actor_id: undefined,
        reference_id: 'system-1',
      })
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'create_notification_atomic',
      expect.objectContaining({
        p_actor_id: null,
        p_link: null,
        p_deduplicate: false,
        p_dedup_window_seconds: 0,
      })
    )
  })

  it('lets a reliable system caller explicitly deduplicate without an actor', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement({
        outcome: 'DEDUPLICATED',
        type: 'subscription_expiring',
        title: 'Expiry',
        message: 'Renew soon',
        link: null,
        actor_id: null,
        reference_id: 'subscription-1',
        deduplicate: true,
        dedup_window_seconds: 259200,
      }),
      error: null,
    })

    await expect(
      deliverNotification(
        supabase,
        input({
          type: 'subscription_expiring',
          title: 'Expiry',
          message: 'Renew soon',
          link: undefined,
          actor_id: undefined,
          reference_id: 'subscription-1',
        }),
        { deduplicate: true, dedupWindowSeconds: 259200 }
      )
    ).resolves.toMatchObject({ created: false, deduplicated: true })
  })

  it('accepts an exact self-skip without a fake persisted identity', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement({
        outcome: 'SKIPPED_SELF',
        actor_id: RECIPIENT_ID,
        notification_id: null,
        created_at: null,
      }),
      error: null,
    })

    await expect(
      deliverNotification(supabase, input({ actor_id: RECIPIENT_ID }))
    ).resolves.toMatchObject({ skippedSelf: true, notificationId: null, createdAt: null })
  })

  it.each([
    [input({ user_id: 'bad' }), undefined, 'bad recipient'],
    [input({ title: ' ' }), undefined, 'blank title'],
    [input({ message: 'x'.repeat(1001) }), undefined, 'oversized message'],
    [input({ type: 'tip_received' }), undefined, 'financial-authority notification'],
    [input({ link: 'https://evil.example' }), undefined, 'external link'],
    [input({ read: true }), undefined, 'pre-read notification'],
    [
      input({ actor_id: undefined, reference_id: undefined }),
      { deduplicate: true },
      'dedup without reference',
    ],
    [input(), { deduplicate: false, dedupWindowSeconds: 10 }, 'window without dedup'],
  ])('rejects an invalid request before the RPC (%s)', async (notification, options) => {
    await expect(
      deliverNotification(supabase, notification as never, options as never)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    [
      'recipient unavailable',
      { success: false, reason: 'RECIPIENT_UNAVAILABLE' },
      'RECIPIENT_UNAVAILABLE',
    ],
    ['actor unavailable', { success: false, reason: 'ACTOR_UNAVAILABLE' }, 'ACTOR_UNAVAILABLE'],
    [
      'impossible invalid request',
      { success: false, reason: 'INVALID' },
      'INVALID_ACKNOWLEDGEMENT',
    ],
  ])('maps %s without claiming delivery', async (_label, data, code) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(deliverNotification(supabase, input())).rejects.toMatchObject({ code })
  })

  it('preserves an RPC failure as an observable delivery error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(deliverNotification(supabase, input())).rejects.toMatchObject({
      code: 'RPC_ERROR',
    })
  })

  it.each([
    ['missing acknowledgement', null],
    ['extra field', { ...acknowledgement(), stale: true }],
    ['wrong recipient', acknowledgement({ recipient_id: ACTOR_ID })],
    ['wrong type', acknowledgement({ type: 'system' })],
    ['wrong title', acknowledgement({ title: 'Other' })],
    ['wrong message', acknowledgement({ message: 'Other' })],
    ['wrong link', acknowledgement({ link: '/other' })],
    ['wrong actor', acknowledgement({ actor_id: null })],
    ['wrong reference', acknowledgement({ reference_id: 'other' })],
    ['wrong dedup flag', acknowledgement({ deduplicate: false })],
    ['wrong dedup window', acknowledgement({ dedup_window_seconds: 1 })],
    ['missing persisted identity', acknowledgement({ notification_id: null })],
    ['malformed created time', acknowledgement({ created_at: 'later' })],
  ])('fails closed on %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(deliverNotification(supabase, input())).rejects.toMatchObject({
      code: 'INVALID_ACKNOWLEDGEMENT',
    })
  })

  it('keeps best-effort callers non-blocking but hands the real promise to observability', async () => {
    expect(sendNotification(supabase, input(), 'like-notification')).toBeUndefined()
    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
    expect(mockFireAndForget).toHaveBeenCalledWith(expect.any(Promise), 'like-notification')
    await expect(mockFireAndForget.mock.calls[0]?.[0]).resolves.toMatchObject({ created: true })
  })

  it('uses the same authority for batches and the backward-compatible awaited helper', async () => {
    sendNotifications(supabase, [input(), input()], 'mention-batch')
    expect(mockFireAndForget).toHaveBeenCalledWith(expect.any(Promise), 'mention-batch')
    await expect(mockFireAndForget.mock.calls[0]?.[0]).resolves.toHaveLength(2)

    await expect(createNotificationDeduped(supabase, input())).resolves.toMatchObject({
      outcome: 'CREATED',
    })
    expect(mockRpc).toHaveBeenCalledTimes(3)
  })

  it('contains no select-then-insert notification race', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/data/notifications.ts'), 'utf8')
    const deliverySource = source.slice(source.indexOf('export async function deliverNotification'))

    expect(deliverySource).toContain(".rpc('create_notification_atomic'")
    expect(deliverySource).not.toContain(".from('notifications')")
    expect(deliverySource).not.toContain('oneHourAgo')
  })

  it('exposes typed delivery errors to reliable callers', () => {
    const error = new NotificationDeliveryError('RPC_ERROR', 'failed')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotificationDeliveryError')
    expect(error.code).toBe('RPC_ERROR')
  })
})
