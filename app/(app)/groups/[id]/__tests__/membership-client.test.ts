import {
  buildJoinMembershipBody,
  joinFailureMessage,
  parseMembershipAck,
} from '../membership-client'

const REQUEST_ID = '30000000-0000-4000-8000-000000000003'

describe('group membership client acknowledgements', () => {
  it('passes an invite token to the one membership write request', () => {
    expect(buildJoinMembershipBody('signed-invite')).toEqual({
      action: 'join',
      invite_token: 'signed-invite',
    })
    expect(buildJoinMembershipBody()).toEqual({ action: 'join' })
  })

  it('accepts joined only with an authoritative non-negative member count', () => {
    expect(parseMembershipAck({ success: true, action: 'joined', member_count: 8 })).toEqual({
      action: 'joined',
      member_count: 8,
    })
    expect(parseMembershipAck({ success: true, action: 'joined' })).toBeNull()
    expect(parseMembershipAck({ success: true, action: 'joined', member_count: 8.5 })).toBeNull()
  })

  it('accepts idempotent already-member acknowledgements without inventing a count', () => {
    expect(
      parseMembershipAck({
        success: true,
        action: 'already_member',
        role: 'admin',
        member_count: 8,
      })
    ).toEqual({ action: 'already_member', role: 'admin', member_count: 8 })
    expect(parseMembershipAck({ success: true, action: 'already_member' })).toEqual({
      action: 'already_member',
    })
  })

  it('accepts requested only with durable request evidence', () => {
    expect(
      parseMembershipAck({
        success: true,
        action: 'requested',
        request_id: REQUEST_ID,
        already_pending: true,
      })
    ).toEqual({ action: 'requested', request_id: REQUEST_ID, already_pending: true })
    expect(parseMembershipAck({ success: true, action: 'requested' })).toBeNull()
  })

  it('rejects unknown, failed and malformed success payloads', () => {
    expect(parseMembershipAck({ success: false, action: 'joined', member_count: 8 })).toBeNull()
    expect(parseMembershipAck({ success: true, action: 'future_action' })).toBeNull()
    expect(parseMembershipAck(null)).toBeNull()
  })
})

describe('joinFailureMessage', () => {
  const t = (key: string) =>
    ({
      groupJoinBanned: 'banned',
      groupJoinScoreTooLow: 'needs {score}+',
      groupJoinVerifiedOnly: 'verified only',
      proRequired: 'pro required',
      groupJoinApprovalRequired: 'approval required',
      groupJoinDissolved: 'dissolved',
      inviteAlreadyUsed: 'invite used',
      joinFailed: 'join failed',
      inviteInvalidOrExpired: 'invite invalid',
    })[key] ?? key

  it.each([
    ['BANNED', 'banned'],
    ['VERIFIED_ONLY', 'verified only'],
    ['PREMIUM_REQUIRED', 'pro required'],
    ['APPROVAL_REQUIRED', 'approval required'],
    ['DISSOLVED', 'dissolved'],
    ['INVITE_ALREADY_USED', 'invite used'],
  ])('maps %s to its specific reason', (code, expected) => {
    expect(joinFailureMessage({ code, error: 'server text' }, t, 'joinFailed')).toBe(expected)
  })

  it('includes the required score', () => {
    expect(joinFailureMessage({ code: 'SCORE_TOO_LOW', required_score: 60 }, t, 'joinFailed')).toBe(
      'needs 60+'
    )
  })

  it('falls back to the generic or invite message for unknown failures', () => {
    expect(joinFailureMessage({ error: 'boom' }, t, 'joinFailed')).toBe('join failed')
    expect(joinFailureMessage(null, t, 'inviteInvalidOrExpired')).toBe('invite invalid')
  })
})
