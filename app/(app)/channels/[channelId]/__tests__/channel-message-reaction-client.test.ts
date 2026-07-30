import { readChannelMessageReactionAcknowledgement } from '../channel-message-reaction-client'

const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      operationId: OPERATION_ID,
      messageId: MESSAGE_ID,
      action: 'added',
      emoji: '🔥',
      counts: { '👍': 2, '🔥': 1 },
      userEmojis: ['🔥'],
      replayed: false,
      ...overrides,
    },
  }
}

const expected = { operationId: OPERATION_ID, messageId: MESSAGE_ID, emoji: '🔥' }

describe('readChannelMessageReactionAcknowledgement', () => {
  it('adopts only exact aggregate evidence bound to the operation', () => {
    expect(readChannelMessageReactionAcknowledgement(acknowledgement(), expected)).toEqual([
      { emoji: '👍', count: 2, mine: false },
      { emoji: '🔥', count: 1, mine: true },
    ])
    expect(
      readChannelMessageReactionAcknowledgement(
        acknowledgement({ action: 'removed', counts: { '👍': 2 }, userEmojis: [] }),
        expected
      )
    ).toEqual([{ emoji: '👍', count: 2, mine: false }])
  })

  it.each([
    null,
    {},
    { success: true, data: null },
    acknowledgement({ operationId: MESSAGE_ID }),
    acknowledgement({ messageId: OPERATION_ID }),
    acknowledgement({ emoji: '👍' }),
    acknowledgement({ replayed: 'false' }),
    acknowledgement({ action: 'removed' }),
    acknowledgement({ counts: { '🔥': 0 } }),
    acknowledgement({ counts: { '🔥': 1.5 } }),
    acknowledgement({ counts: { '🔥': 1 }, userEmojis: ['🔥', '🔥'] }),
    acknowledgement({ counts: {}, userEmojis: ['🔥'] }),
    acknowledgement({ extra: true }),
    { ...acknowledgement(), extra: true },
  ])('rejects malformed, contradictory, or unbound evidence %#', (value) => {
    expect(readChannelMessageReactionAcknowledgement(value, expected)).toBeNull()
  })
})
