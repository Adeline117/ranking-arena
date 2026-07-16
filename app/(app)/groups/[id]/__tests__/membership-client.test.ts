import { buildJoinMembershipBody, parseMembershipAck } from '../membership-client'

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
