import type { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

type DatabaseError = { code?: string }

export type CommentMutationFailure =
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'conflict'
  | 'database'

export class CommentMutationRolloutError extends Error {
  constructor(
    public readonly kind: CommentMutationFailure,
    public readonly databaseCode?: string,
    public readonly stage?: string
  ) {
    super(`Comment mutation failed: ${kind}`)
    this.name = 'CommentMutationRolloutError'
  }
}

export type UpdatedComment = Record<string, unknown> & {
  id: string
  post_id: string
  user_id: string
  content: string
  deleted_at: null
}

export type DeleteOwnCommentResult = {
  deleted_count: number
  comment_count: number
}

export type ModerateCommentResult = {
  post_id: string
  affected_count: number
  comment_count: number
}

export type ModerateCommentAction = 'hard_delete' | 'soft_delete' | 'restore_auto_hidden'

export type ModerateCommentInput = {
  commentId: string
  expectedPostId?: string
  actorId: string | null
  action: ModerateCommentAction
  reason: string | null
}

function fail(
  operation: string,
  stage: string,
  kind: CommentMutationFailure,
  error?: DatabaseError
): never {
  logger.error('[canonical comment mutation] operation failed', {
    operation,
    stage,
    ...(error?.code ? { code: error.code } : {}),
  })
  throw new CommentMutationRolloutError(kind, error?.code, stage)
}

function failForRpc(operation: string, error: DatabaseError): never {
  if (error.code === 'P0002' || error.code === '23503') {
    return fail(operation, 'rpc', 'not_found', error)
  }
  if (error.code === '42501') return fail(operation, 'rpc', 'forbidden', error)
  if (error.code === '22023') return fail(operation, 'rpc', 'validation', error)
  if (
    error.code === '23514' ||
    error.code === '23505' ||
    error.code === '40001' ||
    error.code === '40P01'
  ) {
    return fail(operation, 'rpc', 'conflict', error)
  }
  return fail(operation, 'rpc', 'database', error)
}

function parseUpdatedComment(
  value: unknown,
  expected: { commentId: string; postId: string; userId: string; content: string }
): UpdatedComment | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const candidate = row as Record<string, unknown>
  if (
    candidate.id !== expected.commentId ||
    candidate.post_id !== expected.postId ||
    candidate.user_id !== expected.userId ||
    candidate.content !== expected.content ||
    candidate.deleted_at !== null ||
    typeof candidate.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(candidate.updated_at))
  ) {
    return null
  }
  return candidate as UpdatedComment
}

function parseDeleteOwnComment(value: unknown): DeleteOwnCommentResult | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const candidate = row as Record<string, unknown>
  if (
    !Number.isSafeInteger(candidate.deleted_count) ||
    (candidate.deleted_count as number) <= 0 ||
    !Number.isSafeInteger(candidate.comment_count) ||
    (candidate.comment_count as number) < 0
  ) {
    return null
  }
  return {
    deleted_count: candidate.deleted_count as number,
    comment_count: candidate.comment_count as number,
  }
}

export function parseModerateComment(value: unknown): ModerateCommentResult | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const candidate = row as Record<string, unknown>
  if (
    typeof candidate.post_id !== 'string' ||
    candidate.post_id.length === 0 ||
    !Number.isSafeInteger(candidate.affected_count) ||
    (candidate.affected_count as number) < 0 ||
    !Number.isSafeInteger(candidate.comment_count) ||
    (candidate.comment_count as number) < 0
  ) {
    return null
  }
  return {
    post_id: candidate.post_id,
    affected_count: candidate.affected_count as number,
    comment_count: candidate.comment_count as number,
  }
}

export async function updateOwnCommentWithRollout(
  supabase: SupabaseClient,
  input: { commentId: string; postId: string; userId: string; content: string }
): Promise<UpdatedComment> {
  const operation = 'update-own-comment'
  const { data, error } = await supabase.rpc('update_own_comment', {
    p_comment_id: input.commentId,
    p_post_id: input.postId,
    p_user_id: input.userId,
    p_content: input.content,
  })

  if (error) failForRpc(operation, error)
  const result = parseUpdatedComment(data, input)
  if (!result) fail(operation, 'rpc-ack', 'database')
  return result
}

export async function deleteOwnCommentWithRollout(
  supabase: SupabaseClient,
  input: { commentId: string; postId: string; userId: string }
): Promise<DeleteOwnCommentResult> {
  const operation = 'delete-own-comment'
  const { data, error } = await supabase.rpc('delete_own_comment', {
    p_comment_id: input.commentId,
    p_post_id: input.postId,
    p_user_id: input.userId,
  })

  if (error) failForRpc(operation, error)
  const result = parseDeleteOwnComment(data)
  if (!result) fail(operation, 'rpc-ack', 'database')
  return result
}

export async function moderateCommentWithRollout(
  supabase: SupabaseClient,
  input: ModerateCommentInput
): Promise<ModerateCommentResult> {
  const operation = 'moderate-comment'
  if (!['hard_delete', 'soft_delete', 'restore_auto_hidden'].includes(input.action)) {
    fail(operation, 'input', 'validation')
  }

  const { data, error } = await supabase.rpc('moderate_comment', {
    p_comment_id: input.commentId,
    p_actor_id: input.actorId,
    p_action: input.action,
    p_reason: input.reason,
  })

  if (error) failForRpc(operation, error)
  const result = parseModerateComment(data)
  if (!result) fail(operation, 'rpc-ack', 'database')
  if (input.expectedPostId && result.post_id !== input.expectedPostId) {
    fail(operation, 'rpc-resource-ack', 'conflict')
  }
  return result
}

export async function moderateCommentHardDeleteWithRollout(
  supabase: SupabaseClient,
  input: {
    commentId: string
    expectedPostId: string
    actorId: string | null
    reason: string | null
  }
): Promise<ModerateCommentResult> {
  return moderateCommentWithRollout(supabase, { ...input, action: 'hard_delete' })
}
