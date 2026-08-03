import { readChannelMessageSendAcknowledgement } from '../channel-message-send-client'

const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'

const expected = {
  operationId: OPERATION_ID,
  actorId: ACTOR_ID,
  channelId: CHANNEL_ID,
  content: 'hello channel',
  mediaUrl: null,
  mediaType: null,
  mediaName: null,
  replyToId: null,
} as const

const message = {
  id: MESSAGE_ID,
  channel_id: CHANNEL_ID,
  sender_id: ACTOR_ID,
  content: 'hello channel',
  media_url: null,
  media_type: null,
  media_name: null,
  created_at: '2026-07-30T01:20:00.000Z',
  reply_to_id: null,
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      operationId: OPERATION_ID,
      actorId: ACTOR_ID,
      channelId: CHANNEL_ID,
      message,
      replayed: false,
      ...overrides,
    },
  }
}

describe('readChannelMessageSendAcknowledgement', () => {
  it('adopts only exact message evidence bound to operation, viewer, and channel', () => {
    expect(readChannelMessageSendAcknowledgement(acknowledgement(), expected)).toEqual({
      message,
      replayed: false,
    })
    expect(
      readChannelMessageSendAcknowledgement(acknowledgement({ replayed: true }), expected)
    ).toEqual({ message, replayed: true })
  })

  it.each([
    null,
    {},
    { success: true, data: null },
    acknowledgement({ operationId: MESSAGE_ID }),
    acknowledgement({ actorId: CHANNEL_ID }),
    acknowledgement({ channelId: ACTOR_ID }),
    acknowledgement({ replayed: 'false' }),
    acknowledgement({ message: null }),
    acknowledgement({ message: { ...message, id: 'not-a-uuid' } }),
    acknowledgement({ message: { ...message, channel_id: ACTOR_ID } }),
    acknowledgement({ message: { ...message, sender_id: CHANNEL_ID } }),
    acknowledgement({ message: { ...message, content: 'wrong' } }),
    acknowledgement({ message: { ...message, media_url: 'https://example.com/file' } }),
    acknowledgement({ message: { ...message, created_at: 'not-a-time' } }),
    acknowledgement({ message: { ...message, extra: true } }),
    acknowledgement({ extra: true }),
    { ...acknowledgement(), extra: true },
  ])('rejects malformed, contradictory, or cross-scope evidence %#', (value) => {
    expect(readChannelMessageSendAcknowledgement(value, expected)).toBeNull()
  })
})
