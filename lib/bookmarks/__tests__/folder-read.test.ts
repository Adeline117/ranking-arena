import {
  parseBookmarkFolderDetailRead,
  parseOwnedBookmarkFoldersRead,
  parseProfileBookmarkFoldersRead,
  parseSubscribedBookmarkFoldersRead,
} from '../folder-read'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'
const BOOKMARK_ID = '44444444-4444-4444-8444-444444444444'
const POST_ID = '55555555-5555-4555-8555-555555555555'

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: FOLDER_ID,
    user_id: OWNER_ID,
    name: 'Folder',
    description: null,
    avatar_url: null,
    is_public: true,
    is_default: false,
    post_count: 1,
    subscriber_count: 2,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    bookmark_id: BOOKMARK_ID,
    bookmarked_at: '2026-07-29T03:00:00Z',
    id: POST_ID,
    title: 'Post',
    content: null,
    author_id: OWNER_ID,
    author_handle: 'owner',
    group_id: null,
    like_count: 1,
    comment_count: 2,
    bookmark_count: 3,
    created_at: '2026-07-29T02:00:00Z',
    ...overrides,
  }
}

describe('bookmark folder read snapshot parsers', () => {
  it('accepts an exact owned snapshot bound to its actor', () => {
    expect(
      parseOwnedBookmarkFoldersRead(
        {
          status: 'ok',
          actor_id: ACTOR_ID,
          folders: [folder({ user_id: ACTOR_ID })],
        },
        ACTOR_ID
      )
    ).toMatchObject({ status: 'ok', actorId: ACTOR_ID })
  })

  it.each([
    { actor_id: OWNER_ID },
    { extra: true },
    { folders: [folder({ user_id: OWNER_ID })] },
    { folders: [folder({ user_id: ACTOR_ID }), folder({ user_id: ACTOR_ID })] },
  ])('rejects a malformed or crossed owned snapshot: %p', (override) => {
    expect(() =>
      parseOwnedBookmarkFoldersRead(
        {
          status: 'ok',
          actor_id: ACTOR_ID,
          folders: [folder({ user_id: ACTOR_ID })],
          ...override,
        },
        ACTOR_ID
      )
    ).toThrow()
  })

  it('accepts exact subscribed owner metadata and pagination', () => {
    const result = parseSubscribedBookmarkFoldersRead(
      {
        status: 'ok',
        actor_id: ACTOR_ID,
        folders: [
          {
            ...folder(),
            owner_id: OWNER_ID,
            owner_handle: 'owner',
            owner_avatar_url: null,
            subscribed_at: '2026-07-29T04:00:00Z',
          },
        ],
        pagination: { limit: 1, offset: 0, has_more: true },
      },
      { actorId: ACTOR_ID, limit: 1, offset: 0 }
    )

    expect(result).toMatchObject({
      status: 'ok',
      folders: [{ id: FOLDER_ID, subscriber_count: 2 }],
      pagination: { has_more: true },
    })
  })

  it.each([
    { is_public: false },
    { owner_id: ACTOR_ID, user_id: ACTOR_ID },
    { subscriber_count: 0 },
    { owner_handle: undefined },
  ])('rejects an impossible subscribed folder: %p', (override) => {
    expect(() =>
      parseSubscribedBookmarkFoldersRead(
        {
          status: 'ok',
          actor_id: ACTOR_ID,
          folders: [
            {
              ...folder(),
              owner_id: OWNER_ID,
              owner_handle: 'owner',
              owner_avatar_url: null,
              subscribed_at: '2026-07-29T04:00:00Z',
              ...override,
            },
          ],
          pagination: { limit: 1, offset: 0, has_more: false },
        },
        { actorId: ACTOR_ID, limit: 1, offset: 0 }
      )
    ).toThrow()
  })

  it('accepts an anonymous public profile snapshot', () => {
    expect(
      parseProfileBookmarkFoldersRead(
        {
          status: 'ok',
          actor_id: null,
          profile_id: OWNER_ID,
          include_private: false,
          folders: [folder()],
        },
        { actorId: null, profileId: OWNER_ID, includePrivate: false }
      )
    ).toMatchObject({ status: 'ok', actorId: null, profileId: OWNER_ID })
  })

  it('rejects a private folder in a public profile acknowledgement', () => {
    expect(() =>
      parseProfileBookmarkFoldersRead(
        {
          status: 'ok',
          actor_id: null,
          profile_id: OWNER_ID,
          include_private: false,
          folders: [folder({ is_public: false })],
        },
        { actorId: null, profileId: OWNER_ID, includePrivate: false }
      )
    ).toThrow()
  })

  it('accepts a coherent detail page and lookahead state', () => {
    expect(
      parseBookmarkFolderDetailRead(
        {
          status: 'ok',
          actor_id: ACTOR_ID,
          folder: { ...folder({ post_count: 2 }), owner_handle: 'owner', owner_avatar_url: null },
          posts: [post()],
          is_owner: false,
          is_subscribed: true,
          pagination: { limit: 1, offset: 0, has_more: true },
        },
        { actorId: ACTOR_ID, folderId: FOLDER_ID, limit: 1, offset: 0 }
      )
    ).toMatchObject({ status: 'ok', isOwner: false, isSubscribed: true })
  })

  it.each([
    { actor_id: OWNER_ID },
    { is_owner: true },
    { folder: { ...folder({ post_count: 1 }), owner_handle: 'owner', owner_avatar_url: null } },
    { pagination: { limit: 1, offset: 0, has_more: false } },
    { posts: [post(), post()] },
  ])('rejects crossed or incoherent detail state: %p', (override) => {
    expect(() =>
      parseBookmarkFolderDetailRead(
        {
          status: 'ok',
          actor_id: ACTOR_ID,
          folder: { ...folder({ post_count: 2 }), owner_handle: 'owner', owner_avatar_url: null },
          posts: [post()],
          is_owner: false,
          is_subscribed: true,
          pagination: { limit: 1, offset: 0, has_more: true },
          ...override,
        },
        { actorId: ACTOR_ID, folderId: FOLDER_ID, limit: 1, offset: 0 }
      )
    ).toThrow()
  })

  it('accepts exact denials and rejects denial fields that could hide mixed state', () => {
    expect(
      parseBookmarkFolderDetailRead(
        { status: 'folder_forbidden' },
        { actorId: ACTOR_ID, folderId: FOLDER_ID, limit: 20, offset: 0 }
      )
    ).toEqual({ status: 'folder_forbidden' })
    expect(() =>
      parseBookmarkFolderDetailRead(
        { status: 'folder_forbidden', folder: folder() },
        { actorId: ACTOR_ID, folderId: FOLDER_ID, limit: 20, offset: 0 }
      )
    ).toThrow()
  })
})
