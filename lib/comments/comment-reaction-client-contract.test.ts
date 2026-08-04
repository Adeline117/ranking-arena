import { readCommentReactionAcknowledgement } from './comment-reaction-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const COMMENT_ID = '33333333-3333-4333-8333-333333333333'
const TIMESTAMP = '2026-08-03T21:30:00.000Z'

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: ACTOR_ID,
      post_id: POST_ID,
      comment_id: COMMENT_ID,
      operation: 'toggle',
      requested_reaction: 'like',
      action: 'added',
      reaction: 'like',
      liked: true,
      disliked: false,
      like_count: 4,
      dislike_count: 1,
      ...overrides,
    },
    meta: { timestamp: TIMESTAMP },
  }
}

const expected = {
  actorId: ACTOR_ID,
  postId: POST_ID,
  commentId: COMMENT_ID,
  requestedReaction: 'like' as const,
}

describe('readCommentReactionAcknowledgement', () => {
  it.each(['added', 'changed'] as const)('accepts an exact %s toggle receipt', (action) => {
    expect(readCommentReactionAcknowledgement(receipt({ action }), expected)).toEqual({
      actorId: ACTOR_ID,
      postId: POST_ID,
      commentId: COMMENT_ID,
      operation: 'toggle',
      requestedReaction: 'like',
      action,
      reaction: 'like',
      liked: true,
      disliked: false,
      likeCount: 4,
      dislikeCount: 1,
    })
  })

  it('accepts an exact removed toggle receipt', () => {
    expect(
      readCommentReactionAcknowledgement(
        receipt({
          action: 'removed',
          reaction: null,
          liked: false,
          disliked: false,
          like_count: 0,
        }),
        expected
      )
    ).toMatchObject({ action: 'removed', reaction: null, liked: false, disliked: false })
  })

  it.each([
    ['another actor', receipt({ actor_id: '44444444-4444-4444-8444-444444444444' })],
    ['another post', receipt({ post_id: '44444444-4444-4444-8444-444444444444' })],
    ['another comment', receipt({ comment_id: '44444444-4444-4444-8444-444444444444' })],
    ['another requested reaction', receipt({ requested_reaction: 'dislike' })],
    ['another operation', receipt({ operation: 'set' })],
    ['a removed action retaining a reaction', receipt({ action: 'removed' })],
    ['an added action without a reaction', receipt({ reaction: null, liked: false })],
    ['a mismatched resulting reaction', receipt({ reaction: 'dislike' })],
    ['contradictory flags', receipt({ disliked: true })],
    ['a negative count', receipt({ like_count: -1 })],
    ['a fractional count', receipt({ dislike_count: 1.5 })],
    ['an impossible zero own-reaction count', receipt({ like_count: 0 })],
  ])('rejects %s', (_name, value) => {
    expect(readCommentReactionAcknowledgement(value, expected)).toBeNull()
  })

  it.each([
    ['an extra envelope field', { ...receipt(), invented: true }],
    ['an extra receipt field', { ...receipt(), data: { ...receipt().data, invented: true } }],
    ['an extra metadata field', { ...receipt(), meta: { timestamp: TIMESTAMP, trace: 'x' } }],
    ['missing metadata', { success: true, data: receipt().data }],
    ['a non-canonical timestamp', { ...receipt(), meta: { timestamp: '2026-08-03' } }],
  ])('rejects %s', (_name, value) => {
    expect(readCommentReactionAcknowledgement(value, expected)).toBeNull()
  })

  it('rejects an invalid expected identity', () => {
    expect(
      readCommentReactionAcknowledgement(receipt(), { ...expected, actorId: 'viewer-a' })
    ).toBeNull()
  })
})
