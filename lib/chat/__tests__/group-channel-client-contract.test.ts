import {
  readGroupChannelCreationAcknowledgement,
  readGroupMemberSearchResults,
} from '../group-channel-client-contract'

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const channelId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const expected = {
  actorId,
  channelId,
  description: null,
  name: 'Stable group',
}

const acknowledgement = {
  channel: {
    id: channelId,
    name: 'Stable group',
    type: 'group',
    created_by: actorId,
    avatar_url: null,
    description: null,
    conversation_id: null,
    last_message_at: '2026-08-03T12:00:00.000Z',
    last_message_preview: null,
    created_at: '2026-08-03T12:00:00.000Z',
    updated_at: '2026-08-03T12:00:00.000Z',
  },
}

describe('group channel client contracts', () => {
  it('accepts only the exact creation identity and immutable initial channel state', () => {
    expect(readGroupChannelCreationAcknowledgement(acknowledgement, expected)).toEqual({
      channelId,
    })

    expect(
      readGroupChannelCreationAcknowledgement({ ...acknowledgement, success: true }, expected)
    ).toBeNull()
    expect(
      readGroupChannelCreationAcknowledgement(
        { channel: { ...acknowledgement.channel, created_by: channelId } },
        expected
      )
    ).toBeNull()
    expect(
      readGroupChannelCreationAcknowledgement(
        { channel: { ...acknowledgement.channel, name: 'Another group' } },
        expected
      )
    ).toBeNull()
    expect(
      readGroupChannelCreationAcknowledgement(
        { channel: { ...acknowledgement.channel, unexpected: true } },
        expected
      )
    ).toBeNull()
  })

  it('rejects malformed, duplicate, actor and expanded member-search projections', () => {
    const valid = {
      users: [
        {
          id: channelId,
          handle: 'member',
          avatar_url: null,
        },
      ],
    }
    expect(readGroupMemberSearchResults(valid, actorId, 10)).toEqual(valid.users)
    expect(readGroupMemberSearchResults({ ...valid, extra: true }, actorId, 10)).toBeNull()
    expect(
      readGroupMemberSearchResults(
        { users: [{ ...valid.users[0], unexpected: true }] },
        actorId,
        10
      )
    ).toBeNull()
    expect(
      readGroupMemberSearchResults({ users: [valid.users[0], valid.users[0]] }, actorId, 10)
    ).toBeNull()
    expect(
      readGroupMemberSearchResults({ users: [{ ...valid.users[0], id: actorId }] }, actorId, 10)
    ).toBeNull()
  })
})
