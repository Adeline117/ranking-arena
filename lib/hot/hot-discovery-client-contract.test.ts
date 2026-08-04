import {
  HOT_DISCOVERY_PAGE_LIMIT,
  readHotGroupsPage,
  readHotPostsPage,
} from './hot-discovery-client-contract'

const POST_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '22222222-2222-4222-8222-222222222222'

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    title: 'Truth-bound hot post',
    content: 'body',
    author_handle: 'alice',
    author_avatar_url: null,
    group_id: null,
    group_name: null,
    group_name_en: null,
    comment_count: 2,
    like_count: 3,
    dislike_count: 1,
    view_count: 10,
    hot_score: 8.5,
    created_at: '2026-08-03T12:00:00.000Z',
    user_reaction: null,
    bookmark_count: 0,
    ...overrides,
  }
}

function postsEnvelope(posts: unknown[]) {
  return {
    success: true,
    data: { posts },
    meta: {
      pagination: { limit: HOT_DISCOVERY_PAGE_LIMIT, offset: 0, has_more: false },
      timestamp: '2026-08-03T12:00:01.000Z',
    },
  }
}

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    name: 'Arena builders',
    name_en: null,
    description: null,
    avatar_url: null,
    member_count: 5,
    ...overrides,
  }
}

function groupsEnvelope(groups: unknown[], total = groups.length, hasMore = false) {
  return {
    success: true,
    data: {
      groups,
      pagination: {
        limit: HOT_DISCOVERY_PAGE_LIMIT,
        offset: 0,
        total,
        has_more: hasMore,
      },
    },
  }
}

describe('hot discovery client contracts', () => {
  it('accepts the exact hot-post page while ignoring documented shared post additions', () => {
    expect(readHotPostsPage(postsEnvelope([post()]))).toEqual([post()])
  })

  it.each([
    ['legacy envelope', { data: { posts: [post()] } }],
    ['wrong page limit', postsEnvelope([post()])],
    ['invalid post identity', postsEnvelope([post({ id: 'post-1' })])],
    ['negative count', postsEnvelope([post({ like_count: -1 })])],
    ['invalid timestamp', postsEnvelope([post({ created_at: 'today' })])],
    ['wrong viewer state', postsEnvelope([post({ user_reaction: 'sideways' })])],
  ])('rejects %s', (label, value) => {
    if (label === 'wrong page limit') {
      ;(value as ReturnType<typeof postsEnvelope>).meta.pagination.limit = 20 as 30
    }
    expect(readHotPostsPage(value)).toBeNull()
  })

  it('accepts the exact group discovery page', () => {
    expect(readHotGroupsPage(groupsEnvelope([group()]))).toEqual([group()])
  })

  it.each([
    ['fallback-shaped envelope', { groups: [group()] }],
    ['missing mutable field', groupsEnvelope([{ ...group(), member_count: undefined }])],
    ['negative member count', groupsEnvelope([group({ member_count: -1 })])],
    ['invalid identity', groupsEnvelope([group({ id: 'group-1' })])],
    ['inconsistent total', groupsEnvelope([group()], 0)],
    ['inconsistent has-more', groupsEnvelope([group()], 31, true)],
  ])('rejects %s', (_label, value) => {
    expect(readHotGroupsPage(value)).toBeNull()
  })
})
