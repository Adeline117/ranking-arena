import {
  POST_REPOST_OPERATION,
  createPostRepostRequestId,
  readPostRepostAcknowledgement,
} from './post-repost-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_POST_ID = '22222222-2222-4222-8222-222222222222'
const ROOT_POST_ID = '33333333-3333-4333-8333-333333333333'
const REPOST_POST_ID = '44444444-4444-4444-8444-444444444444'
const REQUEST_ID = 'a'.repeat(32)

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ACTOR_ID,
    source_post_id: SOURCE_POST_ID,
    root_post_id: ROOT_POST_ID,
    request_id: REQUEST_ID,
    operation: POST_REPOST_OPERATION,
    action: 'created',
    repost_post_id: REPOST_POST_ID,
    repost_count: 4,
    ...overrides,
  }
}

const expected = {
  actorId: ACTOR_ID,
  sourcePostId: SOURCE_POST_ID,
  rootPostId: ROOT_POST_ID,
  requestId: REQUEST_ID,
  action: 'created' as const,
}

describe('post repost client contract', () => {
  it('generates canonical opaque request nonces', () => {
    expect(createPostRepostRequestId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('accepts the exact created receipt', () => {
    expect(readPostRepostAcknowledgement(receipt(), expected)).toEqual({
      actorId: ACTOR_ID,
      sourcePostId: SOURCE_POST_ID,
      rootPostId: ROOT_POST_ID,
      requestId: REQUEST_ID,
      operation: POST_REPOST_OPERATION,
      action: 'created',
      repostPostId: REPOST_POST_ID,
      repostCount: 4,
    })
  })

  it('accepts an exact already-existing reconciliation only when expected', () => {
    expect(
      readPostRepostAcknowledgement(receipt({ action: 'already_exists' }), {
        ...expected,
        action: 'already_exists',
      })
    ).toMatchObject({ action: 'already_exists', repostPostId: REPOST_POST_ID, repostCount: 4 })
    expect(
      readPostRepostAcknowledgement(receipt({ action: 'already_exists' }), expected)
    ).toBeNull()
  })

  it.each([
    ['another actor', { actor_id: '55555555-5555-4555-8555-555555555555' }],
    ['another source', { source_post_id: '55555555-5555-4555-8555-555555555555' }],
    ['another root', { root_post_id: '55555555-5555-4555-8555-555555555555' }],
    ['another request', { request_id: 'b'.repeat(32) }],
    ['another operation', { operation: 'remove' }],
    ['a negative count', { repost_count: -1 }],
    ['a fractional count', { repost_count: 1.5 }],
    ['an impossible zero count', { repost_count: 0 }],
    ['the source row as the repost row', { repost_post_id: SOURCE_POST_ID }],
    ['the root row as the repost row', { repost_post_id: ROOT_POST_ID }],
  ])('rejects %s', (_name, overrides) => {
    expect(readPostRepostAcknowledgement(receipt(overrides), expected)).toBeNull()
  })

  it.each([
    ['an extra field', { ...receipt(), invented: true }],
    [
      'a missing field',
      (() => {
        const value = receipt()
        delete (value as Partial<typeof value>).request_id
        return value
      })(),
    ],
    [
      'a legacy response',
      {
        success: true,
        post_id: REPOST_POST_ID,
        root_post_id: ROOT_POST_ID,
        repost_count: 4,
        message: 'Repost successful',
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(readPostRepostAcknowledgement(value, expected)).toBeNull()
  })
})
