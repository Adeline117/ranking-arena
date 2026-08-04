import {
  readGroupCommentDeleteAcknowledgement,
  readGroupDissolveAcknowledgement,
  readGroupMemberKickAcknowledgement,
  readGroupMemberRoleAcknowledgement,
} from './group-manage-mutation-contract'

describe('group manage mutation contract', () => {
  it('accepts the exact group comment deletion acknowledgement', () => {
    expect(
      readGroupCommentDeleteAcknowledgement({
        success: true,
        affected_count: 2,
        comment_count: 4,
      })
    ).toEqual({ affectedCount: 2, commentCount: 4 })
  })

  it.each([
    null,
    [],
    { success: true },
    { success: true, affected_count: 1, comment_count: 4, extra: true },
    { success: 'true', affected_count: 1, comment_count: 4 },
    { success: true, affected_count: -1, comment_count: 4 },
    { success: true, affected_count: 1.5, comment_count: 4 },
    { success: true, affected_count: 1, comment_count: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects a malformed or contradictory acknowledgement: %p', (value) => {
    expect(readGroupCommentDeleteAcknowledgement(value)).toBeNull()
  })

  it('binds an exact role acknowledgement to the requested role', () => {
    expect(readGroupMemberRoleAcknowledgement({ success: true, role: 'admin' }, 'admin')).toBe(
      'admin'
    )
    expect(
      readGroupMemberRoleAcknowledgement({ success: true, role: 'member' }, 'admin')
    ).toBeNull()
    expect(
      readGroupMemberRoleAcknowledgement({ success: true, role: 'admin', changed: true }, 'admin')
    ).toBeNull()
  })

  it('accepts only the exact kick acknowledgement', () => {
    expect(readGroupMemberKickAcknowledgement({ success: true })).toBe(true)
    expect(readGroupMemberKickAcknowledgement({ success: true, target_id: 'someone-else' })).toBe(
      false
    )
    expect(readGroupMemberKickAcknowledgement({ success: 'true' })).toBe(false)
  })

  it.each(['dissolved', 'already_dissolved'] as const)(
    'accepts the exact %s group dissolution acknowledgement',
    (action) => {
      expect(
        readGroupDissolveAcknowledgement({
          success: true,
          action,
          dissolved_at: '2026-07-16T12:00:00.000Z',
        })
      ).toEqual({ action, dissolvedAt: '2026-07-16T12:00:00.000Z' })
    }
  )

  it.each([
    { success: true, action: 'dissolved' },
    { success: true, action: 'deleted', dissolved_at: '2026-07-16T12:00:00.000Z' },
    { success: true, action: 'dissolved', dissolved_at: 'not-a-date' },
    {
      success: true,
      action: 'dissolved',
      dissolved_at: '2026-07-16T12:00:00.000Z',
      extra: true,
    },
  ])('rejects a malformed dissolution acknowledgement: %p', (value) => {
    expect(readGroupDissolveAcknowledgement(value)).toBeNull()
  })
})
