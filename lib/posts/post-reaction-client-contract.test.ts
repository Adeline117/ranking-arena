import { readPostReactionAcknowledgement } from './post-reaction-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const TIMESTAMP = '2026-08-03T20:30:00.000Z'

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: ACTOR_ID,
      post_id: POST_ID,
      requested_reaction: 'up',
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
  requestedReaction: 'up' as const,
}

describe('readPostReactionAcknowledgement', () => {
  it('accepts the exact identity-bound added receipt', () => {
    expect(readPostReactionAcknowledgement(receipt(), expected)).toEqual({
      actorId: ACTOR_ID,
      postId: POST_ID,
      requestedReaction: 'up',
      action: 'added',
      reaction: 'up',
      likeCount: 4,
      dislikeCount: 1,
    })
  })

  it('accepts an exact removed receipt with zero counters', () => {
    expect(
      readPostReactionAcknowledgement(
        receipt({ action: 'removed', reaction: null, like_count: 0, dislike_count: 0 }),
        expected
      )
    ).toMatchObject({ action: 'removed', reaction: null, likeCount: 0, dislikeCount: 0 })
  })

  it.each([
    ['another actor', receipt({ actor_id: '33333333-3333-4333-8333-333333333333' })],
    ['another post', receipt({ post_id: '33333333-3333-4333-8333-333333333333' })],
    ['another requested reaction', receipt({ requested_reaction: 'down' })],
    ['a mismatched resulting reaction', receipt({ reaction: 'down' })],
    ['a removed action with a reaction', receipt({ action: 'removed' })],
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
})
