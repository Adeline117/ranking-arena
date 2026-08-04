import {
  POST_BOOKMARK_OPERATION,
  POST_BOOKMARK_STATUS_OPERATION,
  createPostBookmarkRequestId,
  isDefinitivePostBookmarkRejection,
  readPostBookmarkAcknowledgement,
  readPostBookmarkStatusAcknowledgement,
} from '@/lib/bookmarks/post-bookmark-client-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_POST_ID = '33333333-3333-4333-8333-333333333333'
const FOLDER_ID = '44444444-4444-4444-8444-444444444444'
const REQUEST_ID = 'a'.repeat(32)

function toggleReceipt(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ACTOR_ID,
    post_id: POST_ID,
    request_id: REQUEST_ID,
    operation: POST_BOOKMARK_OPERATION,
    action: 'added',
    bookmarked: true,
    bookmark_count: 1,
    folder_id: FOLDER_ID,
    ...overrides,
  }
}

function statusReceipt(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ACTOR_ID,
    request_id: REQUEST_ID,
    operation: POST_BOOKMARK_STATUS_OPERATION,
    post_ids: [POST_ID, OTHER_POST_ID],
    bookmarks: { [POST_ID]: true, [OTHER_POST_ID]: false },
    ...overrides,
  }
}

describe('post bookmark client receipts', () => {
  it('distinguishes definitive client rejection from uncertain transport/server outcomes', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(isDefinitivePostBookmarkRejection(status)).toBe(true)
    }
    for (const status of [0, 200, 201, 408, 500, 502, 503, 504]) {
      expect(isDefinitivePostBookmarkRejection(status)).toBe(false)
    }
  })

  it('generates a canonical opaque request nonce', () => {
    expect(createPostBookmarkRequestId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it.each([
    ['another actor', { actor_id: OTHER_POST_ID }],
    ['another post', { post_id: OTHER_POST_ID }],
    ['another request', { request_id: 'b'.repeat(32) }],
    ['another operation', { operation: 'status' }],
    ['extra key', { invented: true }],
    ['negative count', { bookmark_count: -1 }],
    ['impossible removed state', { action: 'removed', bookmarked: false }],
  ])('rejects a toggle receipt from %s', (_label, overrides) => {
    expect(
      readPostBookmarkAcknowledgement(toggleReceipt(overrides), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
      })
    ).toBeNull()
  })

  it('accepts exact added and removed toggle receipts', () => {
    expect(
      readPostBookmarkAcknowledgement(toggleReceipt(), {
        actorId: ACTOR_ID,
        postId: POST_ID,
        requestId: REQUEST_ID,
      })
    ).toMatchObject({ bookmarked: true, bookmarkCount: 1, folderId: FOLDER_ID })
    expect(
      readPostBookmarkAcknowledgement(
        toggleReceipt({ action: 'removed', bookmarked: false, bookmark_count: 0, folder_id: null }),
        { actorId: ACTOR_ID, postId: POST_ID, requestId: REQUEST_ID }
      )
    ).toMatchObject({ bookmarked: false, bookmarkCount: 0, folderId: null })
  })

  it.each([
    ['another actor', { actor_id: OTHER_POST_ID }],
    ['another request', { request_id: 'b'.repeat(32) }],
    ['another operation', { operation: 'toggle' }],
    ['truncated posts', { post_ids: [POST_ID], bookmarks: { [POST_ID]: true } }],
    ['missing bookmark key', { bookmarks: { [POST_ID]: true } }],
    [
      'extra bookmark key',
      { bookmarks: { [POST_ID]: true, [OTHER_POST_ID]: false, [FOLDER_ID]: true } },
    ],
    ['non-boolean truth', { bookmarks: { [POST_ID]: true, [OTHER_POST_ID]: 1 } }],
    ['duplicate posts', { post_ids: [POST_ID, POST_ID] }],
    ['extra key', { invented: true }],
  ])('rejects a status receipt with %s', (_label, overrides) => {
    expect(
      readPostBookmarkStatusAcknowledgement(statusReceipt(overrides), {
        actorId: ACTOR_ID,
        requestId: REQUEST_ID,
        postIds: [POST_ID, OTHER_POST_ID],
      })
    ).toBeNull()
  })

  it('accepts an exact identity- and request-bound status snapshot', () => {
    expect(
      readPostBookmarkStatusAcknowledgement(statusReceipt(), {
        actorId: ACTOR_ID,
        requestId: REQUEST_ID,
        postIds: [POST_ID, OTHER_POST_ID],
      })
    ).toEqual({
      actorId: ACTOR_ID,
      requestId: REQUEST_ID,
      operation: POST_BOOKMARK_STATUS_OPERATION,
      postIds: [POST_ID, OTHER_POST_ID],
      bookmarks: { [POST_ID]: true, [OTHER_POST_ID]: false },
    })
  })
})
