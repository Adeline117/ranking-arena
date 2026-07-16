import { applyRealtimePostCommentCount, parseRealtimePostCommentCount } from '../post-comment-count'

describe('realtime post comment count reconciliation', () => {
  it('accepts only a non-negative safe integer absolute count', () => {
    expect(parseRealtimePostCommentCount({ id: 'post-1', comment_count: 7 })).toEqual({
      postId: 'post-1',
      commentCount: 7,
    })
    expect(parseRealtimePostCommentCount({ id: 'post-1', comment_count: -1 })).toBeNull()
    expect(parseRealtimePostCommentCount({ id: 'post-1', comment_count: 1.5 })).toBeNull()
    expect(parseRealtimePostCommentCount({ id: 'post-1', comment_count: '7' })).toBeNull()
    expect(parseRealtimePostCommentCount({ comment_count: 7 })).toBeNull()
  })

  it('corrects optimistic drift with an absolute value instead of applying another delta', () => {
    const posts = [
      { id: 'post-1', comment_count: 12, title: 'one' },
      { id: 'post-2', comment_count: 4, title: 'two' },
    ]

    const next = applyRealtimePostCommentCount(posts, {
      postId: 'post-1',
      commentCount: 9,
    })

    expect(next).toEqual([
      { id: 'post-1', comment_count: 9, title: 'one' },
      { id: 'post-2', comment_count: 4, title: 'two' },
    ])
  })

  it('is idempotent for duplicate delivery and ignores unrelated posts', () => {
    const posts = [{ id: 'post-1', comment_count: 9 }]

    expect(applyRealtimePostCommentCount(posts, { postId: 'post-1', commentCount: 9 })).toBe(posts)
    expect(applyRealtimePostCommentCount(posts, { postId: 'post-2', commentCount: 10 })).toBe(posts)
  })

  it('converges after rapid insert/delete updates without accumulating deltas', () => {
    const initial = [{ id: 'post-1', comment_count: 20 }]
    const afterInsert = applyRealtimePostCommentCount(initial, {
      postId: 'post-1',
      commentCount: 21,
    })
    const afterDelete = applyRealtimePostCommentCount(afterInsert, {
      postId: 'post-1',
      commentCount: 20,
    })
    const afterDuplicateDelete = applyRealtimePostCommentCount(afterDelete, {
      postId: 'post-1',
      commentCount: 20,
    })

    expect(afterDelete[0].comment_count).toBe(20)
    expect(afterDuplicateDelete).toBe(afterDelete)
  })
})
