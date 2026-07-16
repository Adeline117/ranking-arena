import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import {
  CommentMutationRolloutError,
  deleteOwnCommentWithRollout,
  moderateCommentHardDeleteWithRollout,
  moderateCommentWithRollout,
  parseModerateComment,
  updateOwnCommentWithRollout,
} from './comment-mutation-rollout'

const mockRpc = jest.fn()
const supabase = {
  rpc: (...args: unknown[]) => mockRpc(...args),
} as unknown as SupabaseClient<Database>

const updatedComment = {
  id: 'comment-1',
  post_id: 'post-1',
  user_id: 'user-1',
  content: 'updated',
  deleted_at: null,
  updated_at: '2026-07-15T00:00:00.000Z',
}

describe('canonical comment mutation client', () => {
  beforeEach(() => jest.clearAllMocks())

  it('updates through the exact RPC and validates the returned resource tuple', async () => {
    mockRpc.mockResolvedValue({ data: [updatedComment], error: null })

    await expect(
      updateOwnCommentWithRollout(supabase, {
        commentId: 'comment-1',
        postId: 'post-1',
        userId: 'user-1',
        content: 'updated',
      })
    ).resolves.toEqual(updatedComment)
    expect(mockRpc).toHaveBeenCalledWith('update_own_comment', {
      p_comment_id: 'comment-1',
      p_post_id: 'post-1',
      p_user_id: 'user-1',
      p_content: 'updated',
    })
  })

  it.each([
    { data: [] },
    { data: [{ ...updatedComment, user_id: 'other-user' }] },
    { data: [{ ...updatedComment, updated_at: 'invalid' }] },
  ])('fails closed for malformed update acknowledgement %#', async ({ data }) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(
      updateOwnCommentWithRollout(supabase, {
        commentId: 'comment-1',
        postId: 'post-1',
        userId: 'user-1',
        content: 'updated',
      })
    ).rejects.toMatchObject({ kind: 'database', stage: 'rpc-ack' })
  })

  it.each([
    ['P0002', 'not_found'],
    ['23503', 'not_found'],
    ['42501', 'forbidden'],
    ['22023', 'validation'],
    ['23514', 'conflict'],
    ['23505', 'conflict'],
    ['40001', 'conflict'],
    ['40P01', 'conflict'],
    ['PGRST202', 'database'],
    ['42883', 'database'],
    ['XX000', 'database'],
  ])('maps RPC error %s to %s without touching legacy tables', async (code, kind) => {
    mockRpc.mockResolvedValue({ data: null, error: { code } })

    await expect(
      updateOwnCommentWithRollout(supabase, {
        commentId: 'comment-1',
        postId: 'post-1',
        userId: 'user-1',
        content: 'updated',
      })
    ).rejects.toMatchObject({
      name: 'CommentMutationRolloutError',
      kind,
      databaseCode: code,
      stage: 'rpc',
    })
  })

  it('deletes through the exact RPC and requires positive affected count', async () => {
    mockRpc.mockResolvedValue({
      data: [{ deleted_count: 2, comment_count: 7 }],
      error: null,
    })

    await expect(
      deleteOwnCommentWithRollout(supabase, {
        commentId: 'comment-1',
        postId: 'post-1',
        userId: 'user-1',
      })
    ).resolves.toEqual({ deleted_count: 2, comment_count: 7 })
    expect(mockRpc).toHaveBeenCalledWith('delete_own_comment', {
      p_comment_id: 'comment-1',
      p_post_id: 'post-1',
      p_user_id: 'user-1',
    })
  })

  it.each([
    [{ deleted_count: 0, comment_count: 7 }],
    [{ deleted_count: 1, comment_count: -1 }],
    [{ deleted_count: 1.5, comment_count: 7 }],
  ])('fails closed for malformed delete acknowledgement %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(
      deleteOwnCommentWithRollout(supabase, {
        commentId: 'comment-1',
        postId: 'post-1',
        userId: 'user-1',
      })
    ).rejects.toMatchObject({ kind: 'database', stage: 'rpc-ack' })
  })

  it.each(['hard_delete', 'soft_delete', 'restore_auto_hidden'] as const)(
    'moderates %s through the exact RPC',
    async (action) => {
      mockRpc.mockResolvedValue({
        data: [{ post_id: 'post-1', affected_count: 1, comment_count: 4 }],
        error: null,
      })

      await expect(
        moderateCommentWithRollout(supabase, {
          commentId: 'comment-1',
          expectedPostId: 'post-1',
          actorId: 'admin-1',
          action,
          reason: 'moderation',
        })
      ).resolves.toEqual({ post_id: 'post-1', affected_count: 1, comment_count: 4 })
      expect(mockRpc).toHaveBeenCalledWith('moderate_comment', {
        p_comment_id: 'comment-1',
        p_actor_id: 'admin-1',
        p_action: action,
        p_reason: 'moderation',
      })
    }
  )

  it('rejects a valid-looking moderation result for another post', async () => {
    mockRpc.mockResolvedValue({
      data: [{ post_id: 'post-2', affected_count: 1, comment_count: 4 }],
      error: null,
    })

    await expect(
      moderateCommentWithRollout(supabase, {
        commentId: 'comment-1',
        expectedPostId: 'post-1',
        actorId: 'admin-1',
        action: 'soft_delete',
        reason: null,
      })
    ).rejects.toMatchObject({ kind: 'conflict', stage: 'rpc-resource-ack' })
  })

  it('rejects an invalid action before dispatch', async () => {
    await expect(
      moderateCommentWithRollout(supabase, {
        commentId: 'comment-1',
        actorId: 'admin-1',
        action: 'invalid' as 'hard_delete',
        reason: null,
      })
    ).rejects.toMatchObject({ kind: 'validation', stage: 'input' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('hard-delete convenience path keeps the expected resource binding', async () => {
    mockRpc.mockResolvedValue({
      data: [{ post_id: 'post-1', affected_count: 2, comment_count: 3 }],
      error: null,
    })

    await expect(
      moderateCommentHardDeleteWithRollout(supabase, {
        commentId: 'comment-1',
        expectedPostId: 'post-1',
        actorId: 'admin-1',
        reason: 'cleanup',
      })
    ).resolves.toEqual({ post_id: 'post-1', affected_count: 2, comment_count: 3 })
    expect(mockRpc).toHaveBeenCalledWith(
      'moderate_comment',
      expect.objectContaining({ p_action: 'hard_delete' })
    )
  })

  it('exports a strict moderation result parser for route acknowledgements', () => {
    expect(
      parseModerateComment([{ post_id: 'post-1', affected_count: 0, comment_count: 3 }])
    ).toEqual({ post_id: 'post-1', affected_count: 0, comment_count: 3 })
    expect(parseModerateComment([{ post_id: '', affected_count: 0, comment_count: 3 }])).toBeNull()
  })

  it('keeps the public error type stable for existing route mappings', () => {
    expect(new CommentMutationRolloutError('forbidden', '42501', 'rpc')).toMatchObject({
      name: 'CommentMutationRolloutError',
      kind: 'forbidden',
      databaseCode: '42501',
      stage: 'rpc',
    })
  })
})
