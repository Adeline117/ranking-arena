import {
  readBookmarkFolderSaveResponse,
  validateBookmarkFolderSaveAck,
} from '@/lib/bookmarks/folder-save'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'
const BOOKMARK_ID = '44444444-4444-4444-8444-444444444444'
const expected = { userId: USER_ID, postId: POST_ID, folderId: FOLDER_ID }

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    status: 'added',
    user_id: USER_ID,
    post_id: POST_ID,
    bookmark_id: BOOKMARK_ID,
    folder_id: FOLDER_ID,
    bookmarked: true,
    bookmark_count: 1,
    ...overrides,
  }
}

describe('bookmark folder save acknowledgements', () => {
  it.each(['added', 'moved', 'already_saved'] as const)(
    'accepts an exact identity-bound %s acknowledgement',
    (status) => {
      expect(validateBookmarkFolderSaveAck(acknowledgement({ status }), expected)).toEqual(
        acknowledgement({ status })
      )
    }
  )

  it.each([
    ['wrong user', { user_id: '55555555-5555-4555-8555-555555555555' }],
    ['wrong post', { post_id: '55555555-5555-4555-8555-555555555555' }],
    ['wrong folder', { folder_id: '55555555-5555-4555-8555-555555555555' }],
    ['invalid bookmark', { bookmark_id: 'not-a-uuid' }],
    ['negative count', { bookmark_count: -1 }],
    ['fractional count', { bookmark_count: 1.5 }],
    ['false state', { bookmarked: false }],
    ['extra field', { action: 'added' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateBookmarkFolderSaveAck(acknowledgement(overrides), expected)).toThrow(
      'acknowledgement mismatch'
    )
    expect(readBookmarkFolderSaveResponse(acknowledgement(overrides), expected)).toBeNull()
  })

  it.each(['invalid', 'account_inactive', 'post_not_found', 'folder_not_found'] as const)(
    'accepts the exact authority denial %s but never exposes it as success',
    (status) => {
      expect(validateBookmarkFolderSaveAck({ status }, expected)).toEqual({ status })
      expect(readBookmarkFolderSaveResponse({ status }, expected)).toBeNull()
    }
  )
})
