import { readGroupInviteAcknowledgement } from '../group-invite-client'

const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_GROUP_ID = '44444444-4444-4444-8444-444444444444'
const EXPIRES_AT = '2026-08-10T00:00:00.000Z'
const ORIGIN = 'https://arena.example'

function inviteToken(groupId = GROUP_ID, expiresAt = Date.parse(EXPIRES_AT), marker = 'a') {
  return Buffer.from(
    `${groupId}:${expiresAt}:${marker.repeat(32)}:${marker.repeat(64)}`,
    'utf8'
  ).toString('base64url')
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    invite_url: `/groups/${GROUP_ID}?invite=${inviteToken()}`,
    expires_at: EXPIRES_AT,
    ...overrides,
  }
}

describe('readGroupInviteAcknowledgement', () => {
  it('accepts only the exact group-bound invite acknowledgement', () => {
    const value = acknowledgement()
    expect(readGroupInviteAcknowledgement(value, GROUP_ID, ORIGIN)).toEqual({
      expiresAt: EXPIRES_AT,
      invitePath: value.invite_url,
      inviteUrl: `${ORIGIN}${value.invite_url}`,
    })
  })

  it('accepts the same token expiry expressed as a valid timezone-offset timestamp', () => {
    const expiresAt = '2026-08-09T17:00:00-07:00'
    expect(
      readGroupInviteAcknowledgement(acknowledgement({ expires_at: expiresAt }), GROUP_ID, ORIGIN)
    ).toEqual(
      expect.objectContaining({
        expiresAt,
      })
    )
  })

  it.each([
    null,
    [],
    { invite_url: `/groups/${GROUP_ID}?invite=${inviteToken()}`, expires_at: EXPIRES_AT },
    acknowledgement({ success: false }),
    { ...acknowledgement(), extra: true },
    acknowledgement({
      invite_url: `https://evil.example/groups/${GROUP_ID}?invite=${inviteToken()}`,
    }),
    acknowledgement({ invite_url: `//evil.example/groups/${GROUP_ID}?invite=${inviteToken()}` }),
    acknowledgement({ invite_url: `/\\evil.example/groups/${GROUP_ID}?invite=${inviteToken()}` }),
    acknowledgement({ invite_url: `/groups/${OTHER_GROUP_ID}?invite=${inviteToken()}` }),
    acknowledgement({ invite_url: `/groups/${GROUP_ID}?invite=${inviteToken(OTHER_GROUP_ID)}` }),
    acknowledgement({ invite_url: `/groups/${GROUP_ID}` }),
    acknowledgement({ invite_url: `/groups/${GROUP_ID}?invite=` }),
    acknowledgement({
      invite_url: `/groups/${GROUP_ID}?invite=${inviteToken()}&invite=${inviteToken()}`,
    }),
    acknowledgement({ invite_url: `/groups/${GROUP_ID}?invite=${inviteToken()}&next=/feed` }),
    acknowledgement({ invite_url: `/groups/${GROUP_ID}?invite=${inviteToken()}#members` }),
    acknowledgement({ expires_at: 'not-a-date' }),
    acknowledgement({ expires_at: '2026-08-11T00:00:00.000Z' }),
    acknowledgement({ invite_url: `/groups/${GROUP_ID}?invite=not-a-token` }),
  ])('rejects a mixed, unsafe, or unbound acknowledgement: %#', (value) => {
    expect(readGroupInviteAcknowledgement(value, GROUP_ID, ORIGIN)).toBeNull()
  })
})
