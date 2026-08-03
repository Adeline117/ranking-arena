jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      for (const [key, value] of Object.entries(init.headers ?? {})) this.headers.set(key, value)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/server-cache', () => ({
  deleteServerCacheByPrefix: jest.fn(),
}))
jest.mock('@/lib/cache', () => ({ del: jest.fn().mockResolvedValue(undefined) }))
const mockDeliverNotification = jest.fn().mockResolvedValue({ outcome: 'CREATED' })
jest.mock('@/lib/data/notifications', () => ({
  deliverNotification: (...args: unknown[]) => mockDeliverNotification(...args),
}))
const mockFireAndForget = jest.fn()
jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() })),
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import type { Database } from '@/lib/supabase/database.types'
import {
  executeAtomicPostCreate,
  extractMentionHandles,
  handleAtomicPostCreateHttp,
  preparePostCreate,
  type PreparedPostCreate,
} from './post-create-server'

const ACTOR = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const POST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const POLL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const post = {
  id: POST,
  author_id: ACTOR,
  author_handle: '测试_user',
  group_id: null,
  title: 'Canonical title',
  content: 'First line\nSecond line #Bitcoin',
  images: ['https://cdn.example/image.png'],
  poll_enabled: false,
  poll_id: null,
  visibility: 'public' as const,
  is_sensitive: false,
  content_warning: null,
  language: 'en',
  mentions: [] as string[],
  hashtags: ['bitcoin'],
  author_arena_score: 42,
  author_is_verified: true,
  content_version: 0,
  status: 'active' as const,
  created_at: '2026-07-30T01:45:00.123456+00:00',
  updated_at: '2026-07-30T01:45:00.123456+00:00',
}

function acknowledgement(status: 'created' | 'replayed' = 'created') {
  return {
    status,
    applied: status === 'created',
    operation_id: OPERATION,
    actor_id: ACTOR,
    post,
    poll: null,
  }
}

function clientWith(result: unknown): SupabaseClient<Database> {
  return {
    rpc: jest.fn().mockResolvedValue(result),
    from: jest.fn(),
  } as unknown as SupabaseClient<Database>
}

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

const prepared: PreparedPostCreate = {
  operationId: OPERATION,
  title: post.title,
  content: post.content,
  groupId: null,
  visibility: 'public',
  images: post.images,
  isSensitive: false,
  contentWarning: null,
  language: 'en',
  pollEnabled: false,
  pollOptions: null,
  pollType: null,
  pollDurationHours: null,
  mentionHandles: [],
  hashtagTags: ['bitcoin'],
}

describe('post creation server authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDeliverNotification.mockResolvedValue({ outcome: 'CREATED' })
  })

  it('extracts NFC Unicode handles without treating an email suffix as a mention', () => {
    expect(extractMentionHandles('你好 @测试用户 and @Alice_1, not mail@example.com')).toEqual([
      'Alice_1',
      '测试用户',
    ])
  })

  it('prepares one sanitized canonical intent with derived terms', () => {
    expect(
      preparePostCreate({
        operation_id: OPERATION,
        title: '  Canonical title  ',
        content: 'First line\nSecond line #Bitcoin<script>discard</script>',
        images: post.images,
      })
    ).toEqual(prepared)
  })

  it.each([
    [
      'managed field forgery',
      { operation_id: OPERATION, title: 'Title', content: 'Body', hot_score: 999 },
    ],
    [
      'invisible group audience',
      { operation_id: OPERATION, title: 'Title', content: 'Body', visibility: 'group' },
    ],
    [
      'poll metadata without an enabled poll',
      {
        operation_id: OPERATION,
        title: 'Title',
        content: 'Body',
        poll_type: 'single',
      },
    ],
    [
      'duplicate poll options',
      {
        operation_id: OPERATION,
        title: 'Title',
        content: 'Body',
        poll_enabled: true,
        poll_options: ['Yes', ' yes '],
        poll_type: 'single',
        poll_duration_hours: 24,
      },
    ],
  ])('rejects %s', (_label, body) => {
    expect(preparePostCreate(body)).toBeNull()
  })

  it('sends one exact operation intent and accepts exact persisted evidence', async () => {
    const client = clientWith({ data: acknowledgement(), error: null })
    await expect(executeAtomicPostCreate(client, ACTOR, prepared)).resolves.toEqual({
      status: 'created',
      acknowledgement: acknowledgement(),
    })
    expect(client.rpc).toHaveBeenCalledWith('create_post_atomic', {
      p_actor_id: ACTOR,
      p_operation_id: OPERATION,
      p_title: post.title,
      p_content: post.content,
      p_group_id: null,
      p_visibility: 'public',
      p_images: post.images,
      p_is_sensitive: false,
      p_content_warning: null,
      p_language: 'en',
      p_poll_enabled: false,
      p_poll_option_texts: null,
      p_poll_type: null,
      p_poll_duration_hours: null,
      p_mention_handles: [],
      p_hashtag_tags: ['bitcoin'],
    })
  })

  it('requires exact custom poll binding, options, and duration evidence', async () => {
    const customInput: PreparedPostCreate = {
      ...prepared,
      pollEnabled: true,
      pollOptions: ['Bullish', 'Bearish'],
      pollType: 'single',
      pollDurationHours: 24,
    }
    const customPost = { ...post, poll_enabled: true, poll_id: POLL }
    const customPoll = {
      id: POLL,
      post_id: POST,
      question: post.title,
      options: [
        { text: 'Bullish', votes: 0, index: 0 },
        { text: 'Bearish', votes: 0, index: 1 },
      ],
      type: 'single',
      end_at: '2026-07-31T01:45:00.123456+00:00',
    }
    const ack = { ...acknowledgement(), post: customPost, poll: customPoll }

    await expect(
      executeAtomicPostCreate(clientWith({ data: ack, error: null }), ACTOR, customInput)
    ).resolves.toEqual({ status: 'created', acknowledgement: ack })
    await expect(
      executeAtomicPostCreate(
        clientWith({
          data: {
            ...ack,
            poll: {
              ...customPoll,
              options: [
                { text: 'Bullish', votes: 1, index: 0 },
                { text: 'Bearish', votes: 0, index: 1 },
              ],
            },
          },
          error: null,
        }),
        ACTOR,
        customInput
      )
    ).resolves.toEqual({ status: 'invalid_ack' })
  })

  it.each([
    ['changed actor', { ...acknowledgement(), actor_id: OTHER }],
    ['changed title', { ...acknowledgement(), post: { ...post, title: 'Other' } }],
    ['changed hashtags', { ...acknowledgement(), post: { ...post, hashtags: [] } }],
    ['forged revision', { ...acknowledgement(), post: { ...post, content_version: 1 } }],
    ['extra acknowledgement field', { ...acknowledgement(), extra: true }],
  ])('fails closed on %s evidence', async (_label, data) => {
    await expect(
      executeAtomicPostCreate(clientWith({ data, error: null }), ACTOR, prepared)
    ).resolves.toEqual({ status: 'invalid_ack' })
  })

  it('maps operation-key reuse with different content to 409', async () => {
    const response = await handleAtomicPostCreateHttp({
      request: request({ operation_id: OPERATION, title: 'Title', content: 'Body' }),
      supabase: clientWith({ data: { status: 'operation_conflict' }, error: null }),
      actorId: ACTOR,
    })
    expect(response.status).toBe(409)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it.each([
    ['created', 201],
    ['replayed', 200],
  ] as const)('returns the exact %s success envelope', async (status, expectedStatus) => {
    const response = await handleAtomicPostCreateHttp({
      request: request({
        operation_id: OPERATION,
        title: post.title,
        content: post.content,
        images: post.images,
      }),
      supabase: clientWith({ data: acknowledgement(status), error: null }),
      actorId: ACTOR,
    })
    expect(response.status).toBe(expectedStatus)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        post,
        poll: null,
        operation: {
          status,
          applied: status === 'created',
          operation_id: OPERATION,
        },
      },
    })
  })

  it.each(['created', 'replayed'] as const)(
    'durably awaits deduplicated mention delivery after %s acknowledgement',
    async (status) => {
      const mentionedContent = `${post.content} @bob`
      const mentionedPost = { ...post, content: mentionedContent, mentions: ['bob'] }
      const mentionedAcknowledgement = {
        ...acknowledgement(status),
        post: mentionedPost,
      }
      const client = clientWith({ data: mentionedAcknowledgement, error: null })
      ;(client.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockResolvedValue({
            data: [{ id: OTHER, handle: 'bob' }],
            error: null,
          }),
        }),
      })

      const response = await handleAtomicPostCreateHttp({
        request: request({
          operation_id: OPERATION,
          title: post.title,
          content: mentionedContent,
          images: post.images,
        }),
        supabase: client,
        actorId: ACTOR,
      })

      expect(response.status).toBe(status === 'created' ? 201 : 200)
      const deliveryCall = mockFireAndForget.mock.calls.find(
        ([, context]) => context === 'Resolve and deliver mention notifications after post create'
      )
      expect(deliveryCall).toBeDefined()
      await deliveryCall?.[0]
      expect(mockDeliverNotification).toHaveBeenCalledWith(
        client,
        {
          user_id: OTHER,
          type: 'mention',
          title: '测试_user mentioned you in a post',
          message: post.title,
          actor_id: ACTOR,
          link: `/post/${POST}`,
          reference_id: POST,
          read: false,
        },
        { deduplicate: true, dedupWindowSeconds: 604800 }
      )
    }
  )

  it('fails closed with 503 when the RPC schema is unavailable', async () => {
    const response = await handleAtomicPostCreateHttp({
      request: request({ operation_id: OPERATION, title: 'Title', content: 'Body' }),
      supabase: clientWith({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      }),
      actorId: ACTOR,
    })
    expect(response.status).toBe(503)
  })
})
