import {
  COMMENT_REACTION_OPERATION,
  COMMENT_REACTION_INTENT_OPERATION,
  commentReactionCountDelta,
  createCommentReactionRequestId,
  isCanonicalCommentReactionRequestId,
  isCanonicalCommentReactionIntentSequence,
  isDefinitiveCommentReactionRejection,
  nextCommentReactionState,
  readCommentReactionAcknowledgement,
  readCommentReactionFailure,
  readCommentReactionIntentAcknowledgement,
} from './comment-reaction-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const COMMENT_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_ID = '0123456789abcdef0123456789abcdef'
const INTENT_SEQUENCE = '42'
const TIMESTAMP = '2026-08-03T21:30:00.000Z'
const EXPIRES_AT = '2026-08-03T21:35:00.000Z'

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: ACTOR_ID,
      post_id: POST_ID,
      comment_id: COMMENT_ID,
      request_id: REQUEST_ID,
      operation: COMMENT_REACTION_OPERATION,
      intent_sequence: INTENT_SEQUENCE,
      desired_reaction: 'like',
      action: 'added',
      reaction: 'like',
      liked: true,
      disliked: false,
      like_count: 4,
      dislike_count: 1,
      replayed: false,
      ...overrides,
    },
    meta: { timestamp: TIMESTAMP },
  }
}

const expected = {
  actorId: ACTOR_ID,
  postId: POST_ID,
  commentId: COMMENT_ID,
  requestId: REQUEST_ID,
  intentSequence: INTENT_SEQUENCE,
  desiredReaction: 'like' as const,
}

describe('readCommentReactionAcknowledgement', () => {
  it.each(['added', 'changed'] as const)('accepts an exact %s desired-state receipt', (action) => {
    expect(readCommentReactionAcknowledgement(receipt({ action }), expected)).toEqual({
      actorId: ACTOR_ID,
      postId: POST_ID,
      commentId: COMMENT_ID,
      requestId: REQUEST_ID,
      operation: COMMENT_REACTION_OPERATION,
      intentSequence: INTENT_SEQUENCE,
      desiredReaction: 'like',
      action,
      reaction: 'like',
      liked: true,
      disliked: false,
      likeCount: 4,
      dislikeCount: 1,
      replayed: false,
    })
  })

  it('accepts an exact removed receipt', () => {
    const desiredAbsent = { ...expected, desiredReaction: null }
    expect(
      readCommentReactionAcknowledgement(
        receipt({
          action: 'removed',
          desired_reaction: null,
          reaction: null,
          liked: false,
          disliked: false,
          like_count: 0,
        }),
        desiredAbsent
      )
    ).toMatchObject({ action: 'removed', reaction: null, liked: false, disliked: false })
  })

  it.each([
    ['a repeated like state', receipt({ action: 'unchanged' }), expected],
    [
      'a repeated absent state',
      receipt({
        action: 'unchanged',
        desired_reaction: null,
        reaction: null,
        liked: false,
        disliked: false,
      }),
      { ...expected, desiredReaction: null },
    ],
  ])('accepts %s without toggle semantics', (_name, value, desired) => {
    expect(readCommentReactionAcknowledgement(value, desired)).toMatchObject({
      action: 'unchanged',
    })
  })

  it.each([
    ['another actor', receipt({ actor_id: '44444444-4444-4444-8444-444444444444' })],
    ['another post', receipt({ post_id: '44444444-4444-4444-8444-444444444444' })],
    ['another comment', receipt({ comment_id: '44444444-4444-4444-8444-444444444444' })],
    ['another request', receipt({ request_id: 'f'.repeat(32) })],
    ['another intent sequence', receipt({ intent_sequence: '43' })],
    ['another desired reaction', receipt({ desired_reaction: 'dislike' })],
    ['another operation', receipt({ operation: 'toggle' })],
    ['a removed action for a non-null desired state', receipt({ action: 'removed' })],
    ['an added action without a reaction', receipt({ reaction: null, liked: false })],
    ['a mismatched resulting reaction', receipt({ reaction: 'dislike' })],
    ['contradictory flags', receipt({ disliked: true })],
    ['a negative count', receipt({ like_count: -1 })],
    ['a fractional count', receipt({ dislike_count: 1.5 })],
    ['a numeric intent sequence', receipt({ intent_sequence: 42 })],
    ['an invalid replay marker', receipt({ replayed: 'false' })],
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

  it('rejects invalid expected identities', () => {
    expect(
      readCommentReactionAcknowledgement(receipt(), { ...expected, actorId: 'viewer-a' })
    ).toBeNull()
  })

  it('rejects an invalid expected request identity', () => {
    expect(
      readCommentReactionAcknowledgement(receipt(), { ...expected, requestId: 'request-1' })
    ).toBeNull()
  })
})

function intentReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: ACTOR_ID,
      post_id: POST_ID,
      comment_id: COMMENT_ID,
      request_id: REQUEST_ID,
      operation: COMMENT_REACTION_INTENT_OPERATION,
      desired_reaction: 'like',
      status: 'issued',
      intent_sequence: INTENT_SEQUENCE,
      expires_at: EXPIRES_AT,
      replayed: false,
      ...overrides,
    },
    meta: { timestamp: TIMESTAMP },
  }
}

const expectedIntent = {
  actorId: ACTOR_ID,
  postId: POST_ID,
  commentId: COMMENT_ID,
  requestId: REQUEST_ID,
  desiredReaction: 'like' as const,
}

describe('readCommentReactionIntentAcknowledgement', () => {
  it.each([
    ['issued', false],
    ['replayed', true],
  ] as const)('accepts an exact %s intent receipt', (status, replayed) => {
    expect(
      readCommentReactionIntentAcknowledgement(intentReceipt({ status, replayed }), expectedIntent)
    ).toEqual({
      actorId: ACTOR_ID,
      postId: POST_ID,
      commentId: COMMENT_ID,
      requestId: REQUEST_ID,
      operation: COMMENT_REACTION_INTENT_OPERATION,
      desiredReaction: 'like',
      status,
      intentSequence: INTENT_SEQUENCE,
      expiresAt: EXPIRES_AT,
      replayed,
    })
  })

  it.each([
    ['another actor', intentReceipt({ actor_id: '44444444-4444-4444-8444-444444444444' })],
    ['another request', intentReceipt({ request_id: 'f'.repeat(32) })],
    ['another desired state', intentReceipt({ desired_reaction: null })],
    ['contradictory replay marker', intentReceipt({ status: 'replayed', replayed: false })],
    ['zero intent sequence', intentReceipt({ intent_sequence: '0' })],
    ['oversized intent sequence', intentReceipt({ intent_sequence: '9223372036854775808' })],
    ['noncanonical expiry', intentReceipt({ expires_at: '2026-08-03T21:35:00+00:00' })],
    ['extra receipt field', { ...intentReceipt(), data: { ...intentReceipt().data, extra: true } }],
  ])('rejects %s', (_label, value) => {
    expect(readCommentReactionIntentAcknowledgement(value, expectedIntent)).toBeNull()
  })
})

describe('readCommentReactionFailure', () => {
  it.each([
    [409, 'COMMENT_REACTION_STALE', 'stale'],
    [410, 'COMMENT_REACTION_EXPIRED', 'expired'],
    [409, 'COMMENT_REACTION_UNKNOWN_TICKET', 'unknown_ticket'],
    [409, 'COMMENT_REACTION_OPERATION_CONFLICT', 'operation_conflict'],
    [429, 'COMMENT_REACTION_TOO_MANY_PENDING', 'too_many_pending'],
    [400, 'COMMENT_REACTION_INVALID', 'invalid'],
    [404, 'COMMENT_REACTION_NOT_FOUND', 'not_found'],
  ] as const)('maps exact HTTP %i / %s', (status, code, kind) => {
    expect(
      readCommentReactionFailure({ success: false, code, error: 'safe message' }, status)
    ).toEqual({ kind })
  })

  it.each([
    ['wrong status', { success: false, code: 'COMMENT_REACTION_STALE', error: 'stale' }, 410],
    ['extra field', { success: false, code: 'COMMENT_REACTION_STALE', error: 'stale', x: 1 }, 409],
    ['missing success', { code: 'COMMENT_REACTION_STALE', error: 'stale' }, 409],
    ['empty error', { success: false, code: 'COMMENT_REACTION_STALE', error: '' }, 409],
    ['unknown code', { success: false, code: 'STALE', error: 'stale' }, 409],
  ])('rejects %s', (_label, value, status) => {
    expect(readCommentReactionFailure(value, status)).toBeNull()
  })
})

describe('comment reaction request IDs', () => {
  it('creates a canonical 128-bit request identity', () => {
    const requestId = createCommentReactionRequestId()
    expect(isCanonicalCommentReactionRequestId(requestId)).toBe(true)
    expect(requestId).toHaveLength(32)
  })

  it.each(['', 'A'.repeat(32), '0'.repeat(31), '0'.repeat(33), 'not-a-request-id'])(
    'rejects non-canonical request identity %s',
    (value) => {
      expect(isCanonicalCommentReactionRequestId(value)).toBe(false)
    }
  )

  it.each(['1', '42', '9223372036854775807'])(
    'accepts canonical positive bigint intent sequence %s',
    (value) => expect(isCanonicalCommentReactionIntentSequence(value)).toBe(true)
  )

  it.each(['0', '01', '-1', '1.0', '9223372036854775808', 1])(
    'rejects invalid intent sequence %s',
    (value) => expect(isCanonicalCommentReactionIntentSequence(value)).toBe(false)
  )
})

describe('comment reaction desired-state helpers', () => {
  it.each([
    [null, 'like', 'like'],
    ['like', 'like', null],
    ['dislike', 'like', 'like'],
    [null, 'dislike', 'dislike'],
    ['dislike', 'dislike', null],
    ['like', 'dislike', 'dislike'],
  ] as const)('maps %s + %s to %s', (current, selected, desired) => {
    expect(nextCommentReactionState(current, selected)).toBe(desired)
  })

  it.each([
    [null, 'like', 1, 0],
    ['like', null, -1, 0],
    ['like', 'dislike', -1, 1],
    ['dislike', 'like', 1, -1],
    [null, null, 0, 0],
  ] as const)('computes count delta %s -> %s', (current, desired, likeCount, dislikeCount) => {
    expect(commentReactionCountDelta(current, desired)).toEqual({ likeCount, dislikeCount })
  })

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'treats %i as a definitive pre-commit rejection',
    (status) => expect(isDefinitiveCommentReactionRejection(status)).toBe(true)
  )

  it.each([0, 200, 408, 425, 500, 503])('treats %i as uncertain', (status) =>
    expect(isDefinitiveCommentReactionRejection(status)).toBe(false)
  )
})
