jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown
    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
    async json() {
      return this.body
    }
  }
  return { NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockGetUserHandle = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockLoggerError = jest.fn()
const mockFireAndForget = jest.fn()
const mockSendNotification = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  getUserHandle: (...args: unknown[]) => mockGetUserHandle(...args),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    info: jest.fn(),
  }),
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

import { POST } from '../route'

const actorId = '11111111-1111-4111-8111-111111111111'
const messageAuthorId = '22222222-2222-4222-8222-222222222222'
const channelId = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444'
const reactionId = '55555555-5555-4555-8555-555555555555'

function context(channel = channelId, message = messageId) {
  return { params: Promise.resolve({ channelId: channel, messageId: message }) }
}

function request(body: unknown, malformed = false) {
  return {
    json: malformed
      ? jest.fn().mockRejectedValue(new SyntaxError('invalid JSON'))
      : jest.fn().mockResolvedValue(body),
  } as never
}

function acknowledgement(
  overrides: Partial<{
    action: unknown
    actor_id: unknown
    changed: unknown
    channel_id: unknown
    counts: unknown
    emoji: unknown
    message_author_id: unknown
    message_id: unknown
    message_preview: unknown
    reaction_id: unknown
    success: unknown
    user_emojis: unknown
  }> = {}
) {
  return {
    success: true,
    actor_id: actorId,
    channel_id: channelId,
    message_id: messageId,
    reaction_id: reactionId,
    emoji: '🔥',
    action: 'added',
    changed: true,
    counts: { '👍': 1, '🔥': 2 },
    user_emojis: ['🔥'],
    message_author_id: messageAuthorId,
    message_preview: 'message preview',
    ...overrides,
  }
}

function rpcResult(data: unknown, error: { message: string } | null = null) {
  mockRpc.mockResolvedValue({ data, error })
}

describe('POST /api/channels/[channelId]/messages/[messageId]/react', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId, email: 'actor@example.com' })
    mockGetUserHandle.mockResolvedValue('actor')
    mockFrom.mockImplementation(() => {
      throw new Error('channel reaction must not issue direct table queries')
    })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc, from: mockFrom })
    rpcResult(acknowledgement())
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('accepts exact added evidence and notifies the DB-bound message author', async () => {
    const response = await POST(
      request({ emoji: '🔥' }),
      context(channelId.toUpperCase(), messageId.toUpperCase())
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'added',
      emoji: '🔥',
      counts: { '👍': 1, '🔥': 2 },
      userEmojis: ['🔥'],
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('toggle_channel_message_reaction_atomic', {
      p_channel_id: channelId,
      p_message_id: messageId,
      p_actor_id: actorId,
      p_emoji: '🔥',
    })
    expect(mockGetUserHandle).toHaveBeenCalledWith(actorId, 'actor@example.com')
    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      {
        user_id: messageAuthorId,
        type: 'reaction',
        title: 'actor reacted 🔥 to your message',
        message: 'message preview',
        actor_id: actorId,
        link: `/channels/${channelId}`,
        reference_id: `channel-reaction:${messageId}:%F0%9F%94%A5`,
        read: false,
      },
      'Channel reaction notification'
    )
  })

  it('accepts exact removed evidence without sending a notification', async () => {
    rpcResult(
      acknowledgement({
        action: 'removed',
        counts: { '👍': 1 },
        user_emojis: [],
      })
    )

    const response = await POST(request({ emoji: '🔥' }), context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'removed',
      emoji: '🔥',
      counts: { '👍': 1 },
      userEmojis: [],
    })
    expect(mockGetUserHandle).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it('gives a second emoji on the same message a distinct notification identity', async () => {
    rpcResult(
      acknowledgement({
        emoji: '👍',
        counts: { '👍': 1 },
        user_emojis: ['👍'],
      })
    )

    const response = await POST(request({ emoji: '👍' }), context())
    await Promise.resolve()
    await Promise.resolve()

    expect(response.status).toBe(200)
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reference_id: `channel-reaction:${messageId}:%F0%9F%91%8D`,
      }),
      'Channel reaction notification'
    )
  })

  it('requires authentication before parsing input or calling the RPC', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request({ emoji: '🔥' }), context())

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['bad-channel', messageId],
    [channelId, 'bad-message'],
  ])('rejects invalid resource ids before the RPC %#', async (channel, message) => {
    const response = await POST(request({ emoji: '🔥' }), context(channel, message))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before the atomic RPC', async () => {
    const response = await POST(request(null, true), context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([{}, { emoji: '💣' }, { emoji: '🔥', extra: true }, { emoji: 1 }])(
    'rejects invalid emoji input before the atomic RPC %#',
    async (body) => {
      const response = await POST(request(body), context())

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'Invalid emoji' })
      expect(mockRpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['INVALID', 400, 'Invalid emoji'],
    ['ACTOR_UNAVAILABLE', 403, 'Account cannot react'],
    ['CHANNEL_NOT_FOUND', 404, 'Channel not found'],
    ['CHANNEL_NOT_GROUP', 400, 'Channel does not support group reactions'],
    ['MEMBERSHIP_NOT_FOUND', 403, 'Not a member'],
    ['MESSAGE_NOT_FOUND', 404, 'Message not found'],
  ])('maps the exact %s denial without a fallback write', async (reason, status, error) => {
    rpcResult({ success: false, reason })

    const response = await POST(request({ emoji: '🔥' }), context())

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic RPC errors', async () => {
    rpcResult(null, { message: 'serialization failure' })

    const response = await POST(request({ emoji: '🔥' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith('Atomic channel reaction toggle failed', {
      error: 'serialization failure',
    })
  })

  it.each([
    null,
    [],
    { success: false, reason: 'UNKNOWN' },
    { success: false, reason: 'MESSAGE_NOT_FOUND', extra: true },
    acknowledgement({ changed: false }),
    acknowledgement({ action: 'changed' }),
    acknowledgement({ emoji: '💣' }),
    acknowledgement({ actor_id: 'not-a-uuid' }),
    acknowledgement({ channel_id: 'not-a-uuid' }),
    acknowledgement({ message_id: 'not-a-uuid' }),
    acknowledgement({ reaction_id: 'not-a-uuid' }),
    acknowledgement({ message_author_id: 'not-a-uuid' }),
    acknowledgement({ message_preview: null }),
    acknowledgement({ counts: null }),
    acknowledgement({ counts: { '🔥': 0 } }),
    acknowledgement({ counts: { '🔥': 1.5 } }),
    acknowledgement({ user_emojis: ['🔥', '🔥'] }),
    acknowledgement({ counts: { '👍': 1 }, user_emojis: ['🔥'] }),
    { ...acknowledgement(), extra: true },
  ])('rejects malformed or non-exact RPC acknowledgements %#', async (ack) => {
    rpcResult(ack)

    const response = await POST(request({ emoji: '🔥' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic channel reaction toggle returned an invalid acknowledgement'
    )
  })

  it.each([
    acknowledgement({ actor_id: messageAuthorId }),
    acknowledgement({ channel_id: messageAuthorId }),
    acknowledgement({ message_id: messageAuthorId }),
    acknowledgement({ emoji: '👍', counts: { '👍': 1 }, user_emojis: ['👍'] }),
    acknowledgement({ counts: { '👍': 1 }, user_emojis: [] }),
    acknowledgement({ action: 'removed', user_emojis: ['🔥'] }),
  ])('rejects well-shaped evidence bound to the wrong request %#', async (ack) => {
    rpcResult(ack)

    const response = await POST(request({ emoji: '🔥' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic channel reaction acknowledgement did not match its request'
    )
  })
})
