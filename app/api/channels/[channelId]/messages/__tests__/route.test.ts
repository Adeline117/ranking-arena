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
const replyAuthorId = '22222222-2222-4222-8222-222222222222'
const channelId = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444'
const replyId = '55555555-5555-4555-8555-555555555555'

function context(id = channelId) {
  return { params: Promise.resolve({ channelId: id }) }
}

function request(body: unknown, malformed = false) {
  return {
    json: malformed
      ? jest.fn().mockRejectedValue(new SyntaxError('invalid JSON'))
      : jest.fn().mockResolvedValue(body),
  } as never
}

const sentMessage = {
  id: messageId,
  channel_id: channelId,
  sender_id: actorId,
  content: 'hello channel',
  media_url: null,
  media_type: null,
  media_name: null,
  created_at: '2026-07-29T20:00:00.000Z',
  reply_to_id: null,
}

function acknowledgement(
  overrides: Partial<{
    actor_id: unknown
    channel_id: unknown
    message: unknown
    read_at: unknown
    reply_author_id: unknown
    success: unknown
  }> = {}
) {
  return {
    success: true,
    actor_id: actorId,
    channel_id: channelId,
    message: sentMessage,
    reply_author_id: null,
    read_at: '2026-07-29T20:00:00.100Z',
    ...overrides,
  }
}

function rpcResult(data: unknown, error: { message: string } | null = null) {
  mockRpc.mockResolvedValue({ data, error })
}

describe('POST /api/channels/[channelId]/messages', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId, email: 'sender@example.com' })
    mockGetUserHandle.mockResolvedValue('sender')
    mockFrom.mockImplementation(() => {
      throw new Error('channel send must not issue direct table queries')
    })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc, from: mockFrom })
    rpcResult(acknowledgement())
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('sends normalized text through the atomic RPC and accepts exact evidence', async () => {
    const response = await POST(request({ content: '  hello channel  ' }), context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ message: sentMessage })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('send_channel_message_atomic', {
      p_channel_id: channelId,
      p_sender_id: actorId,
      p_content: 'hello channel',
      p_media_url: null,
      p_media_type: null,
      p_media_name: null,
      p_reply_to_id: null,
    })
  })

  it('normalizes media, binds the reply author, and schedules one notification', async () => {
    const mediaUrl = 'https://example.com/file.png'
    const message = {
      ...sentMessage,
      content: '',
      media_url: mediaUrl,
      media_type: 'file',
      media_name: null,
      reply_to_id: replyId,
    }
    rpcResult(
      acknowledgement({
        message,
        reply_author_id: replyAuthorId,
      })
    )

    const response = await POST(
      request({
        media_url: ' HTTPS://EXAMPLE.COM/file.png ',
        media_name: '   ',
        reply_to_id: replyId.toUpperCase(),
      }),
      context(channelId.toUpperCase())
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ message })
    expect(mockRpc).toHaveBeenCalledWith('send_channel_message_atomic', {
      p_channel_id: channelId,
      p_sender_id: actorId,
      p_content: '',
      p_media_url: mediaUrl,
      p_media_type: 'file',
      p_media_name: null,
      p_reply_to_id: replyId,
    })
    expect(mockGetUserHandle).toHaveBeenCalledWith(actorId, 'sender@example.com')
    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      {
        user_id: replyAuthorId,
        type: 'message',
        title: 'sender replied to your message',
        message: 'replied to your message',
        actor_id: actorId,
        link: `/channels/${channelId}`,
        reference_id: messageId,
        read: false,
      },
      'Channel reply notification'
    )
  })

  it('requires authentication before parsing input or calling the RPC', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request({ content: 'hello channel' }), context())

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects an invalid channel id before parsing input or calling the RPC', async () => {
    const response = await POST(request({ content: 'hello channel' }), context('not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before the atomic RPC', async () => {
    const response = await POST(request(null, true), context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { content: '   ' },
    { content: 'x'.repeat(2_001) },
    { content: 'hello', extra: true },
    { media_url: 'http://example.com/file.png' },
    { media_url: 'not a URL' },
    { content: 'hello', media_type: 'image' },
    { content: 'hello', media_name: 'file.png' },
    { content: 'hello', media_url: 'https://example.com/file', media_type: 'audio' },
    { content: 'hello', media_url: 'https://example.com/file', media_name: 'x'.repeat(256) },
    { content: 'hello', reply_to_id: 'not-a-uuid' },
  ])('rejects invalid input before the atomic RPC %#', async (body) => {
    const response = await POST(request(body), context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid message' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400, 'Invalid message'],
    ['ACTOR_UNAVAILABLE', 403, 'Account cannot send messages'],
    ['CHANNEL_NOT_FOUND', 404, 'Channel not found'],
    ['CHANNEL_NOT_GROUP', 400, 'Channel does not support group messages'],
    ['MEMBERSHIP_NOT_FOUND', 403, 'Not a member'],
    ['INVALID_REPLY_TARGET', 400, 'Reply target is no longer available'],
  ])('maps the exact %s denial without a fallback insert', async (reason, status, error) => {
    rpcResult({ success: false, reason })

    const response = await POST(request({ content: 'hello channel' }), context())

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic RPC errors', async () => {
    rpcResult(null, { message: 'serialization failure' })

    const response = await POST(request({ content: 'hello channel' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith('Atomic channel-message send failed', {
      error: 'serialization failure',
    })
  })

  it.each([
    null,
    [],
    { success: false, reason: 'UNKNOWN' },
    { success: false, reason: 'MEMBERSHIP_NOT_FOUND', extra: true },
    acknowledgement({ actor_id: 'not-a-uuid' }),
    acknowledgement({ channel_id: 'not-a-uuid' }),
    acknowledgement({ read_at: 'not-a-timestamp' }),
    acknowledgement({ reply_author_id: 'not-a-uuid' }),
    acknowledgement({ message: null }),
    acknowledgement({ message: { ...sentMessage, extra: true } }),
    acknowledgement({ message: { ...sentMessage, created_at: 'not-a-timestamp' } }),
    acknowledgement({ message: { ...sentMessage, reply_to_id: 'not-a-uuid' } }),
    acknowledgement({
      message: { ...sentMessage, media_type: 'image', media_url: null },
    }),
  ])('rejects malformed or non-exact RPC acknowledgements %#', async (ack) => {
    rpcResult(ack)

    const response = await POST(request({ content: 'hello channel' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic channel-message send returned an invalid acknowledgement'
    )
  })

  it.each([
    acknowledgement({ actor_id: replyAuthorId }),
    acknowledgement({ channel_id: replyAuthorId }),
    acknowledgement({ message: { ...sentMessage, channel_id: replyAuthorId } }),
    acknowledgement({ message: { ...sentMessage, sender_id: replyAuthorId } }),
    acknowledgement({ message: { ...sentMessage, content: 'wrong content' } }),
    acknowledgement({ read_at: '2026-07-29T19:59:59.000Z' }),
    acknowledgement({ reply_author_id: replyAuthorId }),
  ])('rejects well-shaped evidence bound to the wrong request %#', async (ack) => {
    rpcResult(ack)

    const response = await POST(request({ content: 'hello channel' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic channel-message acknowledgement did not match its request'
    )
  })

  it('rejects a reply acknowledgement without the locked reply author', async () => {
    rpcResult(
      acknowledgement({
        message: { ...sentMessage, reply_to_id: replyId },
        reply_author_id: null,
      })
    )

    const response = await POST(
      request({ content: 'hello channel', reply_to_id: replyId }),
      context()
    )

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic channel-message acknowledgement did not match its request'
    )
  })
})
