const mockFrom = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}))

jest.mock('@/lib/cache', () => ({
  getOrSet: jest.fn(),
  CacheKey: { traders: {} },
  CACHE_TTL: {},
}))

jest.mock('../trader-utils', () => ({
  findTraderAcrossSources: jest.fn(),
  getTraderArenaFollowersCountBatch: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}))

import { getTraderFeed } from '../trader-queries'

type Builder = Record<string, jest.Mock>

function queryResult(data: unknown, error: unknown = null): Builder {
  const builder = {} as Builder
  for (const method of ['select', 'or', 'limit', 'is', 'order', 'eq', 'in']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.maybeSingle = jest.fn().mockResolvedValue({ data, error })
  builder.then = jest.fn((resolve, reject) =>
    Promise.resolve({ data, error }).then(resolve, reject)
  )
  return builder
}

describe('getTraderFeed canonical repost activity', () => {
  beforeEach(() => {
    mockFrom.mockReset()
  })

  it('uses immutable profile identity and current root-author handles', async () => {
    const owner = queryResult({ id: 'profile-1' })
    const activity = queryResult([
      {
        id: 'post-1',
        title: 'Group note',
        content: 'Original activity',
        created_at: '2026-07-15T10:00:00.000Z',
        group_id: 'group-1',
        like_count: 2,
        is_pinned: false,
        original_post_id: null,
        groups: { name: 'Alpha Group' },
      },
      {
        id: 'repost-1',
        title: 'Repost wrapper',
        content: 'Worth reading',
        created_at: '2026-07-15T11:00:00.000Z',
        group_id: null,
        like_count: 0,
        is_pinned: false,
        original_post_id: 'root-1',
        groups: null,
      },
    ])
    const roots = queryResult([
      {
        id: 'root-1',
        title: 'Root post',
        content: 'Root content',
        author_id: 'root-author-1',
        author_handle: 'stale-root-handle',
        group_id: null,
        like_count: 7,
        groups: null,
      },
    ])
    const rootProfiles = queryResult([{ id: 'root-author-1', handle: 'current-root-handle' }])
    mockFrom
      .mockReturnValueOnce(owner)
      .mockReturnValueOnce(activity)
      .mockReturnValueOnce(roots)
      .mockReturnValueOnce(rootProfiles)

    const result = await getTraderFeed('renamed-owner')

    expect(activity.eq).toHaveBeenCalledWith('author_id', 'profile-1')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      type: 'repost',
      original_post_id: 'root-1',
      original_author_handle: 'current-root-handle',
      repost_comment: 'Worth reading',
    })
    expect(result[1]).toMatchObject({
      type: 'group_post',
      groupId: 'group-1',
      groupName: 'Alpha Group',
    })
  })
})
