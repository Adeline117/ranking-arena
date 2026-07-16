import type { SupabaseClient } from '@supabase/supabase-js'
import { filterServiceReadablePostRows, getPosts } from '../posts'

type QueryResult = { data: unknown; error: Error | null }

function query(result: QueryResult) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'range', 'neq', 'is', 'eq', 'in', 'not', 'or']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject)
  return builder
}

describe('getPosts service-role fail-closed boundary', () => {
  it.each([
    ['group_ids', { group_ids: [] }],
    ['author_ids', { author_ids: [] }],
    ['post_ids', { post_ids: [] }],
  ])('treats an explicit empty %s scope as terminal empty', async (_label, options) => {
    const from = jest.fn()

    await expect(getPosts({ from } as unknown as SupabaseClient, options)).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('always constrains list candidates to non-deleted rows', async () => {
    const postsQuery = query({ data: [], error: null })
    const client = {
      from: jest.fn((table: string) => {
        if (table !== 'posts') throw new Error(`unexpected table ${table}`)
        return postsQuery
      }),
    } as unknown as SupabaseClient

    await expect(getPosts(client)).resolves.toEqual([])
    expect(postsQuery.neq).toHaveBeenCalledWith('status', 'deleted')
    expect(postsQuery.is).toHaveBeenCalledWith('deleted_at', null)
  })

  it('propagates block lookup failure before serving viewer rows', async () => {
    const accessError = new Error('blocked_users unavailable')
    const postsQuery = query({ data: [], error: null })
    const blockQuery = query({ data: null, error: accessError })
    ;(blockQuery.or as jest.Mock).mockReturnValue(blockQuery)
    const client = {
      from: jest.fn((table: string) => {
        if (table === 'posts') return postsQuery
        if (table === 'blocked_users') return blockQuery
        throw new Error(`unexpected table ${table}`)
      }),
    } as unknown as SupabaseClient

    await expect(getPosts(client, { viewer_id: 'viewer-1' })).rejects.toThrow(accessError)
  })

  it('returns only IDs acknowledged by the canonical service audience RPC', async () => {
    const rows = [
      {
        id: 'public-post',
        group_id: null,
        visibility: 'public',
        status: 'active',
        deleted_at: null,
      },
      {
        id: 'premium-group-post',
        group_id: 'premium-group',
        visibility: 'group',
        status: 'active',
        deleted_at: null,
      },
    ]
    const rpc = jest.fn((_name: string, args: { p_post_id: string }) =>
      Promise.resolve({ data: args.p_post_id === 'premium-group-post', error: null })
    )

    await expect(
      filterServiceReadablePostRows({ rpc } as unknown as SupabaseClient, rows, 'viewer-1')
    ).resolves.toEqual([rows[1]])
    expect(rpc).toHaveBeenNthCalledWith(1, 'can_service_actor_read_post', {
      p_actor_id: 'viewer-1',
      p_post_id: 'public-post',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'can_service_actor_read_post', {
      p_actor_id: 'viewer-1',
      p_post_id: 'premium-group-post',
    })
  })

  it.each([
    ['missing RPC', { data: null, error: { code: 'PGRST202' } }],
    ['database error', { data: null, error: { code: 'XX000' } }],
    ['malformed acknowledgement', { data: null, error: null }],
  ])('returns no rows when the canonical filter has a %s', async (_label, result) => {
    const publicPost = {
      id: 'public-post',
      group_id: null,
      visibility: 'public',
      status: 'active',
      deleted_at: null,
    }
    const rpc = jest.fn().mockResolvedValue(result)

    await expect(
      filterServiceReadablePostRows(
        { rpc } as unknown as SupabaseClient,
        [
          publicPost,
          {
            id: 'premium-group-post',
            group_id: 'premium-group',
            visibility: 'group',
            status: 'active',
            deleted_at: null,
          },
          {
            id: 'follower-post',
            group_id: null,
            visibility: 'followers',
            status: 'active',
            deleted_at: null,
          },
        ],
        'viewer-1'
      )
    ).resolves.toEqual([])
  })

  it('fails closed for a public row when the RPC throws and block state is unknown', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('audience RPC network failure'))

    await expect(
      filterServiceReadablePostRows(
        { rpc } as unknown as SupabaseClient,
        [
          {
            id: 'public-post-by-blocked-author',
            group_id: null,
            visibility: 'public',
            status: 'active',
            deleted_at: null,
          },
        ],
        'viewer-with-unknown-block-state'
      )
    ).resolves.toEqual([])
  })

  it('keeps explicit approvals while denying a sibling whose audience check fails', async () => {
    const rows = [{ id: 'approved-post' }, { id: 'uncertain-post' }, { id: 'denied-post' }]
    const rpc = jest.fn((_name: string, args: { p_post_id: string }) => {
      if (args.p_post_id === 'approved-post') {
        return Promise.resolve({ data: true, error: null })
      }
      if (args.p_post_id === 'uncertain-post') {
        return Promise.resolve({ data: null, error: { code: 'XX000' } })
      }
      return Promise.resolve({ data: false, error: null })
    })

    await expect(
      filterServiceReadablePostRows({ rpc } as unknown as SupabaseClient, rows, 'viewer-1')
    ).resolves.toEqual([rows[0]])
  })

  it('does not locally authorize a public repost wrapper when root visibility cannot be checked', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST202' },
    })

    await expect(
      filterServiceReadablePostRows(
        { rpc } as unknown as SupabaseClient,
        [
          {
            id: 'public-wrapper',
            group_id: null,
            visibility: 'public',
            status: 'active',
            deleted_at: null,
            original_post_id: 'hidden-root',
          },
        ],
        null
      )
    ).resolves.toEqual([])
  })

  it('independently filters an embedded repost root before returning the wrapper', async () => {
    const wrapper = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Wrapper',
      content: '',
      author_id: 'author-1',
      author_handle: 'author',
      group_id: null,
      visibility: 'public',
      status: 'active',
      deleted_at: null,
      created_at: '2026-07-15T00:00:00.000Z',
      original_post_id: '22222222-2222-4222-8222-222222222222',
    }
    const root = {
      id: wrapper.original_post_id,
      title: 'Root',
      content: 'Must not be embedded',
      author_id: 'author-2',
      author_handle: 'root-author',
      group_id: null,
      visibility: 'public',
      status: 'active',
      deleted_at: null,
      created_at: '2026-07-14T00:00:00.000Z',
    }
    const postQueries = [
      query({ data: [wrapper], error: null }),
      query({ data: [root], error: null }),
    ]
    const profileQuery = query({ data: [], error: null })
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null })
    const client = {
      rpc,
      from: jest.fn((table: string) => {
        if (table === 'posts') {
          const next = postQueries.shift()
          if (!next) throw new Error('unexpected posts query')
          return next
        }
        if (table === 'user_profiles') return profileQuery
        throw new Error(`unexpected table ${table}`)
      }),
    } as unknown as SupabaseClient

    const [result] = await getPosts(client)

    expect(result.id).toBe(wrapper.id)
    expect(result.original_post).toBeNull()
    expect(rpc).toHaveBeenNthCalledWith(2, 'can_service_actor_read_post', {
      p_actor_id: null,
      p_post_id: root.id,
    })
  })

  it('keeps canonically-authorized rows in an explicit multi-group scope', async () => {
    const groupPost = {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Paid group post',
      content: 'Authorized',
      author_id: 'author-1',
      author_handle: 'author',
      group_id: '44444444-4444-4444-8444-444444444444',
      visibility: 'group',
      status: 'active',
      deleted_at: null,
      created_at: '2026-07-15T00:00:00.000Z',
      original_post_id: null,
    }
    const postsQuery = query({ data: [groupPost], error: null })
    const blocksQuery = query({ data: [], error: null })
    const profileQuery = query({ data: [], error: null })
    const rpc = jest.fn().mockResolvedValue({ data: true, error: null })
    const client = {
      rpc,
      from: jest.fn((table: string) => {
        if (table === 'posts') return postsQuery
        if (table === 'blocked_users') return blocksQuery
        if (table === 'user_profiles') return profileQuery
        throw new Error(`unexpected table ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await getPosts(client, {
      group_ids: [groupPost.group_id],
      viewer_id: 'viewer-1',
    })

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(groupPost.id)
  })

  it('continues through ranked hot chunks until it fills the readable page', async () => {
    const hotPosts = Array.from({ length: 45 }, (_, index) => ({
      id: `post-${index}`,
      title: `Post ${index}`,
      content: '',
      author_id: `author-${index}`,
      author_handle: `author-${index}`,
      group_id: null,
      visibility: 'public',
      status: 'active',
      deleted_at: null,
      created_at: '2026-07-15T00:00:00.000Z',
      hot_score: 1000 - index,
      original_post_id: null,
    }))
    const postsQuery = query({ data: hotPosts, error: null })
    const profileQuery = query({ data: [], error: null })
    const rpc = jest.fn((_name: string, args: { p_post_id: string }) => {
      const index = Number(args.p_post_id.slice('post-'.length))
      return Promise.resolve({ data: index >= 40, error: null })
    })
    const client = {
      rpc,
      from: jest.fn((table: string) => {
        if (table === 'posts') return postsQuery
        if (table === 'user_profiles') return profileQuery
        throw new Error(`unexpected table ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await getPosts(client, { sort_by: 'hot_score', limit: 1 })

    expect(result.map((post) => post.id)).toEqual(['post-40'])
    expect(rpc).toHaveBeenCalledTimes(45)
  })
})
