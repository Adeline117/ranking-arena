import { readGroupCommentDeleteAcknowledgement } from './group-manage-mutation-contract'

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
})
