import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mockDeliverNotification = jest.fn().mockResolvedValue({ outcome: 'CREATED' })
const mockFireAndForget = jest.fn()

jest.mock('@/lib/data/notifications', () => ({
  deliverNotification: (...args: unknown[]) => mockDeliverNotification(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { schedulePostMentionNotifications } from './post-mention-notifications'

const ACTOR = '11111111-1111-4111-8111-111111111111'
const RECIPIENT_A = '22222222-2222-4222-8222-222222222222'
const RECIPIENT_B = '33333333-3333-4333-8333-333333333333'
const UNACKNOWLEDGED = '44444444-4444-4444-8444-444444444444'
const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function clientWithProfileQueries(options?: {
  recipientData?: Array<{ id: string; handle: string }>
  recipientError?: unknown
  actorData?: { handle: string } | null
  actorError?: unknown
}) {
  const recipientIn = jest.fn().mockResolvedValue({
    data: options?.recipientData ?? [],
    error: options?.recipientError ?? null,
  })
  const actorMaybeSingle = jest.fn().mockResolvedValue({
    data: options?.actorData ?? { handle: 'Alice' },
    error: options?.actorError ?? null,
  })
  const actorEq = jest.fn().mockReturnValue({ maybeSingle: actorMaybeSingle })
  const from = jest
    .fn()
    .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ in: recipientIn }) })
    .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ eq: actorEq }) })

  return {
    client: { from, rpc: jest.fn() } as unknown as SupabaseClient<Database>,
    from,
    recipientIn,
    actorEq,
    actorMaybeSingle,
  }
}

describe('post mention notification scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDeliverNotification.mockResolvedValue({ outcome: 'CREATED' })
  })

  it('observes resolution and every deduplicated non-self delivery in one promise', async () => {
    const { client, from, recipientIn, actorEq } = clientWithProfileQueries({
      recipientData: [
        { id: ACTOR, handle: 'Alice' },
        { id: RECIPIENT_B, handle: 'Carol' },
        { id: RECIPIENT_A, handle: 'Bob' },
        { id: RECIPIENT_A, handle: 'BOB' },
        { id: UNACKNOWLEDGED, handle: 'Mallory' },
      ],
    })

    schedulePostMentionNotifications(
      client,
      {
        actorId: ACTOR,
        postId: POST,
        title: 'Edited title',
        content: 'Body @Bob @Carol',
        mentionHandles: ['Bob', 'bob', 'Alice', 'Carol'],
      },
      'post edit mentions'
    )

    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
    expect(mockFireAndForget).toHaveBeenCalledWith(expect.any(Promise), 'post edit mentions')
    await mockFireAndForget.mock.calls[0][0]

    expect(from).toHaveBeenNthCalledWith(1, 'user_profiles')
    expect(from).toHaveBeenNthCalledWith(2, 'user_profiles')
    expect(recipientIn).toHaveBeenCalledWith('handle', ['Bob', 'Alice', 'Carol'])
    expect(actorEq).toHaveBeenCalledWith('id', ACTOR)
    expect(mockDeliverNotification).toHaveBeenCalledTimes(2)
    expect(mockDeliverNotification.mock.calls.map(([, notification]) => notification)).toEqual([
      {
        user_id: RECIPIENT_A,
        type: 'mention',
        title: 'Alice mentioned you in a post',
        message: 'Edited title',
        actor_id: ACTOR,
        link: `/post/${POST}`,
        reference_id: POST,
        read: false,
      },
      {
        user_id: RECIPIENT_B,
        type: 'mention',
        title: 'Alice mentioned you in a post',
        message: 'Edited title',
        actor_id: ACTOR,
        link: `/post/${POST}`,
        reference_id: POST,
        read: false,
      },
    ])
    for (const call of mockDeliverNotification.mock.calls) {
      expect(call[2]).toEqual({ deduplicate: true, dedupWindowSeconds: 604800 })
    }
  })

  it('preserves create behavior by using an acknowledged actor handle without another query', async () => {
    const recipientIn = jest.fn().mockResolvedValue({
      data: [{ id: RECIPIENT_A, handle: 'Bob' }],
      error: null,
    })
    const from = jest
      .fn()
      .mockReturnValue({ select: jest.fn().mockReturnValue({ in: recipientIn }) })
    const client = { from, rpc: jest.fn() } as unknown as SupabaseClient<Database>

    schedulePostMentionNotifications(
      client,
      {
        actorId: ACTOR,
        actorHandle: 'KnownActor',
        postId: POST,
        title: 'Created title',
        content: 'Body @Bob',
        mentionHandles: ['Bob'],
      },
      'post create mentions'
    )

    await mockFireAndForget.mock.calls[0][0]
    expect(from).toHaveBeenCalledTimes(1)
    expect(mockDeliverNotification).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ title: 'KnownActor mentioned you in a post' }),
      { deduplicate: true, dedupWindowSeconds: 604800 }
    )
  })

  it('does not schedule empty authoritative mention sets', () => {
    const { client, from } = clientWithProfileQueries()
    schedulePostMentionNotifications(
      client,
      {
        actorId: ACTOR,
        postId: POST,
        title: 'No mentions',
        content: 'Body',
        mentionHandles: [],
      },
      'empty mentions'
    )
    expect(mockFireAndForget).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })

  it('keeps recipient-query failures observable without launching deliveries', async () => {
    const failure = new Error('recipient lookup failed')
    const { client } = clientWithProfileQueries({ recipientError: failure })
    schedulePostMentionNotifications(
      client,
      {
        actorId: ACTOR,
        postId: POST,
        title: 'Edited title',
        content: 'Body @Bob',
        mentionHandles: ['Bob'],
      },
      'failed mentions'
    )

    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
    await expect(mockFireAndForget.mock.calls[0][0]).rejects.toBe(failure)
    expect(mockDeliverNotification).not.toHaveBeenCalled()
  })

  it('contains no nested fire-and-forget delivery', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'lib/posts/post-mention-notifications.ts'),
      'utf8'
    )
    expect(source.match(/fireAndForget\(/g)).toHaveLength(1)
    expect(source).toContain('await Promise.all(')
    expect(source).not.toContain('sendNotification(')
    expect(source).not.toContain('sendNotifications(')
  })
})
