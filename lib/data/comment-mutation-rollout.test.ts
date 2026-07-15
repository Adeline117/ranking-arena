import type { SupabaseClient } from '@supabase/supabase-js'

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

import {
  CommentMutationRolloutError,
  deleteOwnCommentWithRollout,
  moderateCommentHardDeleteWithRollout,
  updateOwnCommentWithRollout,
} from './comment-mutation-rollout'

type QueryResult = {
  data?: unknown
  error?: { code?: string } | null
  count?: number | null
}

type QueryBuilder = {
  select: jest.Mock
  eq: jest.Mock
  or: jest.Mock
  limit: jest.Mock
  is: jest.Mock
  delete: jest.Mock
  update: jest.Mock
  insert: jest.Mock
  maybeSingle: jest.Mock
  then: Promise<QueryResult>['then']
}

function createQuery(result: QueryResult = {}): QueryBuilder {
  const resolved = {
    data: Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null,
    error: result.error ?? null,
    ...(Object.prototype.hasOwnProperty.call(result, 'count') ? { count: result.count } : {}),
  }
  const promise = Promise.resolve(resolved)
  const builder = {} as QueryBuilder
  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.or = jest.fn(() => builder)
  builder.limit = jest.fn(() => builder)
  builder.is = jest.fn(() => builder)
  builder.delete = jest.fn(() => builder)
  builder.update = jest.fn(() => builder)
  builder.insert = jest.fn(() => builder)
  builder.maybeSingle = jest.fn(() => promise)
  builder.then = promise.then.bind(promise)
  return builder
}

const queues = new Map<string, QueryBuilder[]>()
const mockFrom = jest.fn((table: string) => {
  const builder = queues.get(table)?.shift()
  if (!builder) throw new Error(`Unexpected query for ${table}`)
  return builder
})
const mockRpc = jest.fn()
// This isolated unit double intentionally implements only the two client
// methods used by the rollout bridge.
// eslint-disable-next-line no-restricted-syntax
const supabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
} as unknown as SupabaseClient

function queue(table: string, result: QueryResult = {}) {
  const builder = createQuery(result)
  const tableQueue = queues.get(table) ?? []
  tableQueue.push(builder)
  queues.set(table, tableQueue)
  return builder
}

const POST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const COMMENT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const AUTHOR_ID = '22222222-2222-4222-8222-222222222222'
const CONTENT = 'Updated comment'
const UPDATED_AT = '2026-07-15T20:00:00.000Z'

const updatedComment = {
  id: COMMENT_ID,
  post_id: POST_ID,
  user_id: USER_ID,
  content: CONTENT,
  deleted_at: null,
  updated_at: UPDATED_AT,
}

function expectFailure(promise: Promise<unknown>, kind: CommentMutationRolloutError['kind']) {
  return expect(promise).rejects.toMatchObject({
    name: 'CommentMutationRolloutError',
    kind,
  })
}

function arrangeLegacyUpdate(
  options: {
    post?: QueryResult
    blocked?: QueryResult
    group?: QueryResult
    ban?: QueryResult
    membership?: QueryResult
    comment?: QueryResult
    update?: QueryResult
  } = {}
) {
  const postResult =
    options.post ??
    ({
      data: {
        id: POST_ID,
        author_id: AUTHOR_ID,
        visibility: 'public',
        group_id: null,
        status: 'active',
        deleted_at: null,
      },
    } satisfies QueryResult)
  const post = postResult.data as { group_id?: string | null } | null
  const builders = {
    post: queue('posts', postResult),
    blocked: queue('blocked_users', options.blocked ?? { data: null }),
    group: undefined as QueryBuilder | undefined,
    ban: undefined as QueryBuilder | undefined,
    membership: undefined as QueryBuilder | undefined,
    comment: queue(
      'comments',
      options.comment ?? {
        data: {
          id: COMMENT_ID,
          post_id: POST_ID,
          user_id: USER_ID,
          deleted_at: null,
        },
      }
    ),
    update: queue('comments', options.update ?? { data: updatedComment }),
  }
  if (post?.group_id) {
    builders.group = queue(
      'groups',
      options.group ?? { data: { id: post.group_id, dissolved_at: null } }
    )
    builders.ban = queue('group_bans', options.ban ?? { data: null })
    builders.membership = queue(
      'group_members',
      options.membership ?? { data: { user_id: USER_ID, muted_until: null } }
    )
  }
  return builders
}

function arrangeLegacyDelete(
  options: {
    post?: QueryResult
    comment?: QueryResult
    subtree?: QueryResult
    deletion?: QueryResult
    recount?: QueryResult
    counter?: QueryResult
  } = {}
) {
  return {
    post: queue('posts', options.post ?? { data: { id: POST_ID } }),
    comment: queue(
      'comments',
      options.comment ?? {
        data: {
          id: COMMENT_ID,
          post_id: POST_ID,
          user_id: USER_ID,
          parent_id: null,
          deleted_at: null,
        },
      }
    ),
    subtree: queue('comments', options.subtree ?? { count: 3 }),
    deletion: queue('comments', options.deletion ?? { data: { id: COMMENT_ID } }),
    recount: queue('comments', options.recount ?? { count: 7 }),
    counter: queue('posts', options.counter ?? { data: { id: POST_ID, comment_count: 7 } }),
  }
}

function arrangeLegacyModeration(
  options: {
    comment?: QueryResult
    post?: QueryResult
    subtree?: QueryResult
    mutation?: QueryResult
    recount?: QueryResult
    counter?: QueryResult
  } = {}
) {
  const commentResult =
    options.comment ??
    ({
      data: {
        id: COMMENT_ID,
        post_id: POST_ID,
        parent_id: null,
        deleted_at: null,
      },
    } satisfies QueryResult)
  return {
    comment: queue('comments', commentResult),
    post: queue('posts', options.post ?? { data: { id: POST_ID } }),
    subtree: queue('comments', options.subtree ?? { count: 2 }),
    mutation: queue('comments', options.mutation ?? { data: { id: COMMENT_ID } }),
    recount: queue('comments', options.recount ?? { count: 5 }),
    counter: queue('posts', options.counter ?? { data: { id: POST_ID, comment_count: 5 } }),
  }
}

describe('comment mutation rollout bridges', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queues.clear()
  })

  describe('updateOwnCommentWithRollout', () => {
    const input = { commentId: COMMENT_ID, postId: POST_ID, userId: USER_ID, content: CONTENT }

    it('uses the canonical RPC and accepts one exact acknowledgement', async () => {
      mockRpc.mockResolvedValue({ data: [updatedComment], error: null })

      await expect(updateOwnCommentWithRollout(supabase, input)).resolves.toEqual(updatedComment)
      expect(mockRpc).toHaveBeenCalledWith('update_own_comment', {
        p_comment_id: COMMENT_ID,
        p_post_id: POST_ID,
        p_user_id: USER_ID,
        p_content: CONTENT,
      })
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each([null, [], [updatedComment, updatedComment], [{}]])(
      'rejects malformed RPC acknowledgement %# without fallback',
      async (data) => {
        mockRpc.mockResolvedValue({ data, error: null })

        await expectFailure(updateOwnCommentWithRollout(supabase, input), 'database')
        expect(mockFrom).not.toHaveBeenCalled()
      }
    )

    it.each([
      ['P0002', 'not_found'],
      ['42501', 'forbidden'],
      ['23514', 'conflict'],
      ['PGRST205', 'database'],
    ] as const)('never falls back for RPC error %s', async (code, kind) => {
      mockRpc.mockResolvedValue({ data: null, error: { code } })

      await expectFailure(updateOwnCommentWithRollout(supabase, input), kind)
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each(['PGRST202', '42883'])('uses a strict legacy update only for %s', async (code) => {
      mockRpc.mockResolvedValue({ data: null, error: { code } })
      const builders = arrangeLegacyUpdate()

      await expect(updateOwnCommentWithRollout(supabase, input)).resolves.toEqual(updatedComment)
      expect(builders.update.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: CONTENT })
      )
      expect(builders.update.eq).toHaveBeenCalledWith('post_id', POST_ID)
      expect(builders.update.eq).toHaveBeenCalledWith('user_id', USER_ID)
      expect(builders.update.is).toHaveBeenCalledWith('deleted_at', null)
      expect(builders.update.maybeSingle).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['missing group', { group: { data: null } }, 'forbidden'],
      [
        'dissolved group',
        { group: { data: { id: 'group-1', dissolved_at: '2026-07-15T00:00:00.000Z' } } },
        'forbidden',
      ],
      ['group lookup failure', { group: { error: { code: 'XX005' } } }, 'database'],
    ] as const)('fails closed for a legacy %s edit', async (_label, options, kind) => {
      mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
      arrangeLegacyUpdate({
        post: {
          data: {
            id: POST_ID,
            author_id: AUTHOR_ID,
            visibility: 'public',
            group_id: 'group-1',
            status: 'active',
            deleted_at: null,
          },
        },
        ...options,
      })

      await expectFailure(updateOwnCommentWithRollout(supabase, input), kind)
    })

    it.each([
      ['post read', { post: { error: { code: 'XX001' } } }, 'database'],
      ['block read', { blocked: { error: { code: 'XX002' } } }, 'database'],
      ['blocked audience', { blocked: { data: { blocker_id: USER_ID } } }, 'forbidden'],
      ['comment read', { comment: { error: { code: 'XX003' } } }, 'database'],
      [
        'ownership',
        {
          comment: {
            data: {
              id: COMMENT_ID,
              post_id: POST_ID,
              user_id: AUTHOR_ID,
              deleted_at: null,
            },
          },
        },
        'forbidden',
      ],
      ['source update', { update: { error: { code: 'XX004' } } }, 'database'],
      ['affected row ACK', { update: { data: null } }, 'conflict'],
    ] as const)('fails closed on legacy %s', async (_label, options, kind) => {
      mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
      arrangeLegacyUpdate(options)

      await expectFailure(updateOwnCommentWithRollout(supabase, input), kind)
    })
  })

  describe('deleteOwnCommentWithRollout', () => {
    const input = { commentId: COMMENT_ID, postId: POST_ID, userId: USER_ID }

    it('uses the canonical RPC and accepts exact absolute counts', async () => {
      mockRpc.mockResolvedValue({
        data: [{ deleted_count: 3, comment_count: 7 }],
        error: null,
      })

      await expect(deleteOwnCommentWithRollout(supabase, input)).resolves.toEqual({
        deleted_count: 3,
        comment_count: 7,
      })
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each([null, [], [{}], [{ deleted_count: 0, comment_count: 2 }]])(
      'rejects malformed delete RPC acknowledgement %#',
      async (data) => {
        mockRpc.mockResolvedValue({ data, error: null })
        await expectFailure(deleteOwnCommentWithRollout(supabase, input), 'database')
        expect(mockFrom).not.toHaveBeenCalled()
      }
    )

    it('does not fallback for a non-missing delete RPC error', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { code: '42501' } })
      await expectFailure(deleteOwnCommentWithRollout(supabase, input), 'forbidden')
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each(['PGRST202', '42883'])(
      'uses strict hard-delete, recount and counter ACK for %s',
      async (code) => {
        mockRpc.mockResolvedValue({ data: null, error: { code } })
        const builders = arrangeLegacyDelete()

        await expect(deleteOwnCommentWithRollout(supabase, input)).resolves.toEqual({
          deleted_count: 3,
          comment_count: 7,
        })
        expect(builders.subtree.select).toHaveBeenCalledWith('id', {
          count: 'exact',
          head: true,
        })
        expect(builders.deletion.delete).toHaveBeenCalledTimes(1)
        expect(builders.deletion.maybeSingle).toHaveBeenCalledTimes(1)
        expect(builders.recount.select).toHaveBeenCalledWith('id', {
          count: 'exact',
          head: true,
        })
        expect(builders.counter.update).toHaveBeenCalledWith({ comment_count: 7 })
        expect(builders.counter.maybeSingle).toHaveBeenCalledTimes(1)
      }
    )

    it.each([
      ['post read', { post: { error: { code: 'XX101' } } }, 'database'],
      ['comment read', { comment: { error: { code: 'XX102' } } }, 'database'],
      ['subtree count', { subtree: { error: { code: 'XX103' } } }, 'database'],
      ['source delete', { deletion: { error: { code: 'XX104' } } }, 'database'],
      ['source ACK', { deletion: { data: null } }, 'conflict'],
      ['exact recount', { recount: { error: { code: 'XX105' } } }, 'database'],
      ['counter update', { counter: { error: { code: 'XX106' } } }, 'database'],
      ['counter ACK', { counter: { data: { id: POST_ID, comment_count: 6 } } }, 'database'],
    ] as const)('fails closed on legacy %s', async (_label, options, kind) => {
      mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
      arrangeLegacyDelete(options)

      await expectFailure(deleteOwnCommentWithRollout(supabase, input), kind)
    })
  })

  describe('moderateCommentHardDeleteWithRollout', () => {
    const hardInput = {
      commentId: COMMENT_ID,
      expectedPostId: POST_ID,
      actorId: USER_ID,
      reason: 'Moderator removal',
    }

    it('uses the canonical moderation RPC and validates its acknowledgement', async () => {
      mockRpc.mockResolvedValue({
        data: [{ post_id: POST_ID, affected_count: 2, comment_count: 5 }],
        error: null,
      })

      await expect(moderateCommentHardDeleteWithRollout(supabase, hardInput)).resolves.toEqual({
        post_id: POST_ID,
        affected_count: 2,
        comment_count: 5,
      })
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each([null, [], [{}], [{ post_id: POST_ID, affected_count: -1, comment_count: 2 }]])(
      'rejects malformed moderation RPC acknowledgement %#',
      async (data) => {
        mockRpc.mockResolvedValue({ data, error: null })
        await expectFailure(moderateCommentHardDeleteWithRollout(supabase, hardInput), 'database')
        expect(mockFrom).not.toHaveBeenCalled()
      }
    )

    it('rejects an RPC acknowledgement bound to another post', async () => {
      mockRpc.mockResolvedValue({
        data: [{ post_id: 'another-post', affected_count: 2, comment_count: 5 }],
        error: null,
      })

      await expectFailure(moderateCommentHardDeleteWithRollout(supabase, hardInput), 'conflict')
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('does not fallback for a non-missing moderation RPC error', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { code: 'P0002' } })
      await expectFailure(moderateCommentHardDeleteWithRollout(supabase, hardInput), 'not_found')
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each(['PGRST202', '42883'])('bridges a legacy hard delete only for %s', async (code) => {
      mockRpc.mockResolvedValue({ data: null, error: { code } })
      const builders = arrangeLegacyModeration()

      await expect(moderateCommentHardDeleteWithRollout(supabase, hardInput)).resolves.toEqual({
        post_id: POST_ID,
        affected_count: 2,
        comment_count: 5,
      })
      expect(builders.mutation?.delete).toHaveBeenCalledTimes(1)
      expect(builders.mutation?.maybeSingle).toHaveBeenCalledTimes(1)
      expect(builders.counter?.update).toHaveBeenCalledWith({ comment_count: 5 })
    })

    it.each([
      ['comment read', { comment: { error: { code: 'XX201' } } }, 'database'],
      [
        'post binding',
        {
          comment: {
            data: {
              id: COMMENT_ID,
              post_id: 'another-post',
              parent_id: null,
              deleted_at: null,
            },
          },
        },
        'not_found',
      ],
      ['post read', { post: { error: { code: 'XX202' } } }, 'database'],
      ['subtree count', { subtree: { error: { code: 'XX203' } } }, 'database'],
      ['source delete', { mutation: { error: { code: 'XX204' } } }, 'database'],
      ['source ACK', { mutation: { data: null } }, 'conflict'],
      ['exact recount', { recount: { error: { code: 'XX205' } } }, 'database'],
      ['counter update', { counter: { error: { code: 'XX206' } } }, 'database'],
    ] as const)('fails closed on legacy hard-delete %s', async (_label, options, kind) => {
      mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
      arrangeLegacyModeration(options)

      await expectFailure(moderateCommentHardDeleteWithRollout(supabase, hardInput), kind)
    })
  })
})
