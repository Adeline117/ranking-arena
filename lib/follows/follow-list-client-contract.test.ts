import {
  FOLLOW_LIST_PAGE_SIZE,
  readFollowListPage,
  type FollowListType,
} from './follow-list-client-contract'

const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const NOW = '2026-08-03T12:00:00.000Z'

function response(
  overrides: Record<string, unknown> = {},
  list: FollowListType = 'followers'
): unknown {
  return {
    success: true,
    data: {
      viewer_id: VIEWER_ID,
      target_user_id: TARGET_ID,
      target_handle: 'Alice',
      list,
      hidden: false,
      users: [
        {
          id: USER_ID,
          handle: 'bob',
          bio: null,
          avatar_url: null,
          followed_at: NOW,
          is_following: true,
        },
      ],
      pagination: {
        limit: FOLLOW_LIST_PAGE_SIZE,
        has_more: false,
        next_cursor: null,
      },
      ...overrides,
    },
    meta: { timestamp: NOW },
  }
}

const expected = {
  viewerId: VIEWER_ID,
  targetHandle: 'alice',
  targetUserId: TARGET_ID,
  list: 'followers' as const,
}

describe('follow-list client contract', () => {
  it('accepts one exact identity-bound page', () => {
    expect(readFollowListPage(response(), expected)).toEqual({
      viewerId: VIEWER_ID,
      targetUserId: TARGET_ID,
      targetHandle: 'Alice',
      list: 'followers',
      hidden: false,
      users: [
        {
          id: USER_ID,
          handle: 'bob',
          bio: null,
          avatar_url: null,
          followed_at: NOW,
          is_following: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    })
  })

  it.each([
    ['viewer', response({ viewer_id: TARGET_ID })],
    ['target id', response({ target_user_id: USER_ID })],
    ['target handle', response({ target_handle: 'mallory' })],
    ['list', response({ list: 'following' })],
  ])('rejects a response bound to another %s', (_label, value) => {
    expect(readFollowListPage(value, expected)).toBeNull()
  })

  it('rejects expanded envelopes and expanded rows', () => {
    expect(readFollowListPage({ ...(response() as object), debug: true }, expected)).toBeNull()
    const expanded = response({
      users: [
        {
          id: USER_ID,
          handle: 'bob',
          bio: null,
          avatar_url: null,
          followed_at: NOW,
          is_following: true,
          email: 'private@example.com',
        },
      ],
    })
    expect(readFollowListPage(expanded, expected)).toBeNull()
  })

  it('rejects incoherent cursors, hidden pages with data, duplicates, and bad ordering', () => {
    expect(
      readFollowListPage(
        response({
          pagination: { limit: FOLLOW_LIST_PAGE_SIZE, has_more: true, next_cursor: null },
        }),
        expected
      )
    ).toBeNull()
    expect(
      readFollowListPage(
        response({
          hidden: true,
          pagination: { limit: FOLLOW_LIST_PAGE_SIZE, has_more: false, next_cursor: null },
        }),
        expected
      )
    ).toBeNull()

    const first = {
      id: USER_ID,
      handle: 'bob',
      bio: null,
      avatar_url: null,
      followed_at: NOW,
      is_following: true,
    }
    expect(readFollowListPage(response({ users: [first, first] }), expected)).toBeNull()
    expect(
      readFollowListPage(
        response({
          users: [
            first,
            {
              ...first,
              id: '44444444-4444-4444-8444-444444444444',
              followed_at: '2026-08-03T12:00:01.000Z',
            },
          ],
        }),
        expected
      )
    ).toBeNull()
  })

  it('enforces descending order at microsecond precision', () => {
    const first = {
      id: USER_ID,
      handle: 'bob',
      bio: 'line one\nline two',
      avatar_url: null,
      followed_at: '2026-08-03T12:00:00.000001Z',
      is_following: true,
    }
    const newer = {
      ...first,
      id: '44444444-4444-4444-8444-444444444444',
      followed_at: '2026-08-03T12:00:00.000002Z',
    }
    expect(readFollowListPage(response({ users: [first, newer] }), expected)).toBeNull()
    expect(readFollowListPage(response({ users: [newer, first] }), expected)).not.toBeNull()
  })

  it('accepts an anonymous hidden page and an opaque next cursor', () => {
    const hidden = response({
      viewer_id: null,
      hidden: true,
      users: [],
      pagination: { limit: FOLLOW_LIST_PAGE_SIZE, has_more: false, next_cursor: null },
    })
    expect(readFollowListPage(hidden, { ...expected, viewerId: null })?.hidden).toBe(true)

    const paged = response({
      pagination: { limit: FOLLOW_LIST_PAGE_SIZE, has_more: true, next_cursor: 'abc_123-Z' },
    })
    expect(readFollowListPage(paged, expected)?.nextCursor).toBe('abc_123-Z')
  })
})
