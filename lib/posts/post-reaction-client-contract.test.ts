import {
  POST_REACTION_OPERATION,
  createPostReactionRequestId,
  isCanonicalPostReactionRequestId,
  isDefinitivePostReactionRejection,
  nextPostReactionState,
  postReactionCountDelta,
  readPostReactionAcknowledgement,
} from './post-reaction-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = '0123456789abcdef0123456789abcdef'
const TIMESTAMP = '2026-08-03T20:30:00.000Z'

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: ACTOR_ID,
      post_id: POST_ID,
      request_id: REQUEST_ID,
      operation: POST_REACTION_OPERATION,
      desired_reaction: 'up',
      action: 'added',
      reaction: 'up',
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
  requestId: REQUEST_ID,
  desiredReaction: 'up' as const,
}

describe('readPostReactionAcknowledgement', () => {
  it('accepts the exact identity-bound added receipt', () => {
    expect(readPostReactionAcknowledgement(receipt(), expected)).toEqual({
      actorId: ACTOR_ID,
      postId: POST_ID,
      requestId: REQUEST_ID,
      operation: POST_REACTION_OPERATION,
      desiredReaction: 'up',
      action: 'added',
      reaction: 'up',
      likeCount: 4,
      dislikeCount: 1,
    })
  })

  it('accepts an exact removed receipt with zero counters', () => {
    const desiredAbsent = { ...expected, desiredReaction: null }
    expect(
      readPostReactionAcknowledgement(
        receipt({
          action: 'removed',
          desired_reaction: null,
          reaction: null,
          like_count: 0,
          dislike_count: 0,
        }),
        desiredAbsent
      )
    ).toMatchObject({ action: 'removed', reaction: null, likeCount: 0, dislikeCount: 0 })
  })

  it.each([
    ['a repeated up state', receipt({ action: 'unchanged' }), expected],
    [
      'a repeated absent state',
      receipt({ action: 'unchanged', desired_reaction: null, reaction: null }),
      { ...expected, desiredReaction: null },
    ],
  ])('accepts %s without toggle semantics', (_name, value, desired) => {
    expect(readPostReactionAcknowledgement(value, desired)).toMatchObject({ action: 'unchanged' })
  })

  it.each([
    ['another actor', receipt({ actor_id: '33333333-3333-4333-8333-333333333333' })],
    ['another post', receipt({ post_id: '33333333-3333-4333-8333-333333333333' })],
    ['another request', receipt({ request_id: 'f'.repeat(32) })],
    ['another operation', receipt({ operation: 'toggle' })],
    ['another desired reaction', receipt({ desired_reaction: 'down' })],
    ['a mismatched resulting reaction', receipt({ reaction: 'down' })],
    ['a removed action for a non-null desired state', receipt({ action: 'removed' })],
    ['an added action without a reaction', receipt({ reaction: null })],
    ['a negative count', receipt({ like_count: -1 })],
    ['a fractional count', receipt({ dislike_count: 1.5 })],
    ['an impossible zero own-reaction count', receipt({ like_count: 0 })],
  ])('rejects %s', (_name, value) => {
    expect(readPostReactionAcknowledgement(value, expected)).toBeNull()
  })

  it.each([
    ['an extra envelope field', { ...receipt(), invented: true }],
    ['an extra receipt field', { ...receipt(), data: { ...receipt().data, invented: true } }],
    ['an extra metadata field', { ...receipt(), meta: { timestamp: TIMESTAMP, trace: 'x' } }],
    ['missing metadata', { success: true, data: receipt().data }],
    ['a non-canonical timestamp', { ...receipt(), meta: { timestamp: '2026-08-03' } }],
  ])('rejects %s', (_name, value) => {
    expect(readPostReactionAcknowledgement(value, expected)).toBeNull()
  })

  it('rejects invalid expected identities instead of comparing opaque strings', () => {
    expect(
      readPostReactionAcknowledgement(receipt(), { ...expected, actorId: 'viewer-a' })
    ).toBeNull()
  })

  it('rejects an invalid expected request identity', () => {
    expect(
      readPostReactionAcknowledgement(receipt(), { ...expected, requestId: 'request-1' })
    ).toBeNull()
  })
})

describe('post reaction request IDs', () => {
  it('creates a canonical 128-bit request identity', () => {
    const requestId = createPostReactionRequestId()
    expect(isCanonicalPostReactionRequestId(requestId)).toBe(true)
    expect(requestId).toHaveLength(32)
  })

  it.each(['', 'A'.repeat(32), '0'.repeat(31), '0'.repeat(33), 'not-a-request-id'])(
    'rejects non-canonical request identity %s',
    (value) => {
      expect(isCanonicalPostReactionRequestId(value)).toBe(false)
    }
  )
})

describe('post reaction desired-state helpers', () => {
  it.each([
    [null, 'up', 'up'],
    ['up', 'up', null],
    ['down', 'up', 'up'],
    [null, 'down', 'down'],
    ['down', 'down', null],
    ['up', 'down', 'down'],
  ] as const)('maps %s + %s to %s', (current, selected, desired) => {
    expect(nextPostReactionState(current, selected)).toBe(desired)
  })

  it.each([
    [null, 'up', 1, 0],
    ['up', null, -1, 0],
    ['up', 'down', -1, 1],
    ['down', 'up', 1, -1],
    [null, null, 0, 0],
  ] as const)('computes count delta %s -> %s', (current, desired, likeCount, dislikeCount) => {
    expect(postReactionCountDelta(current, desired)).toEqual({ likeCount, dislikeCount })
  })

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'treats %i as a definitive pre-commit rejection',
    (status) => expect(isDefinitivePostReactionRejection(status)).toBe(true)
  )

  it.each([0, 200, 408, 425, 500, 503])('treats %i as uncertain', (status) =>
    expect(isDefinitivePostReactionRejection(status)).toBe(false)
  )
})
