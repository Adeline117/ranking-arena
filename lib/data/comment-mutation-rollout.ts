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

export function isMissingDatabaseFunction(error: DatabaseError): boolean {
  return error.code === 'PGRST202' || error.code === '42883'
}

function fail(
  operation: string,
  stage: string,
  kind: CommentMutationFailure,
  error?: DatabaseError
): never {
  logger.error('[comment mutation rollout] operation failed', {
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

async function assertLegacyEditAudience(supabase: SupabaseClient, postId: string, userId: string) {
  const operation = 'update-own-comment'
  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id, author_id, visibility, group_id, status, deleted_at')
    .eq('id', postId)
    .maybeSingle()

  if (postError) fail(operation, 'post-read', 'database', postError)
  if (!post || post.deleted_at || post.status !== 'active') {
    fail(operation, 'post-read', 'not_found')
  }

  const { data: blocked, error: blockedError } = await supabase
    .from('blocked_users')
    .select('blocker_id')
    .or(
      `and(blocker_id.eq.${userId},blocked_id.eq.${post.author_id}),and(blocker_id.eq.${post.author_id},blocked_id.eq.${userId})`
    )
    .limit(1)
    .maybeSingle()

  if (blockedError) fail(operation, 'block-read', 'database', blockedError)
  if (blocked) fail(operation, 'block-read', 'forbidden')

  if (post.group_id) {
    const [groupResult, banResult, membershipResult] = await Promise.all([
      supabase.from('groups').select('id, dissolved_at').eq('id', post.group_id).maybeSingle(),
      supabase
        .from('group_bans')
        .select('user_id')
        .eq('group_id', post.group_id)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('group_members')
        .select('user_id, muted_until')
        .eq('group_id', post.group_id)
        .eq('user_id', userId)
        .maybeSingle(),
    ])

    if (groupResult.error) fail(operation, 'group-read', 'database', groupResult.error)
    if (banResult.error) fail(operation, 'group-ban-read', 'database', banResult.error)
    if (membershipResult.error) {
      fail(operation, 'group-membership-read', 'database', membershipResult.error)
    }
    if (
      !groupResult.data ||
      groupResult.data.dissolved_at ||
      banResult.data ||
      !membershipResult.data
    ) {
      fail(operation, 'group-audience', 'forbidden')
    }
    if (
      membershipResult.data.muted_until &&
      new Date(membershipResult.data.muted_until) > new Date()
    ) {
      fail(operation, 'group-mute', 'forbidden')
    }
  } else if (post.visibility === 'followers') {
    if (post.author_id !== userId) {
      const { data: follows, error: followsError } = await supabase
        .from('user_follows')
        .select('follower_id')
        .eq('follower_id', userId)
        .eq('following_id', post.author_id)
        .maybeSingle()

      if (followsError) fail(operation, 'follow-read', 'database', followsError)
      if (!follows) fail(operation, 'follow-read', 'forbidden')
    }
  } else if (post.visibility !== 'public') {
    fail(operation, 'post-audience', 'forbidden')
  }
}

async function updateCommentCountFromSource(
  supabase: SupabaseClient,
  postId: string,
  operation: string
): Promise<number> {
  const { count, error: countError } = await supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', postId)
    .is('deleted_at', null)

  if (countError) fail(operation, 'comment-recount', 'database', countError)
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    fail(operation, 'comment-recount', 'database')
  }

  const commentCount = count as number
  const { data: post, error: updateError } = await supabase
    .from('posts')
    .update({ comment_count: commentCount })
    .eq('id', postId)
    .select('id, comment_count')
    .maybeSingle()

  if (updateError) fail(operation, 'counter-update', 'database', updateError)
  if (!post || post.id !== postId || post.comment_count !== commentCount) {
    fail(operation, 'counter-ack', 'database')
  }
  return commentCount
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

  if (!error) {
    const result = parseUpdatedComment(data, input)
    if (!result) fail(operation, 'rpc-ack', 'database')
    return result
  }
  if (!isMissingDatabaseFunction(error)) failForRpc(operation, error)

  logger.warn('[comment mutation rollout] RPC missing; using legacy path', {
    operation,
    code: error.code,
  })
  await assertLegacyEditAudience(supabase, input.postId, input.userId)

  const { data: existing, error: existingError } = await supabase
    .from('comments')
    .select('id, post_id, user_id, deleted_at')
    .eq('id', input.commentId)
    .maybeSingle()

  if (existingError) fail(operation, 'comment-read', 'database', existingError)
  if (!existing || existing.post_id !== input.postId || existing.deleted_at) {
    fail(operation, 'comment-read', 'not_found')
  }
  if (existing.user_id !== input.userId) fail(operation, 'ownership', 'forbidden')

  const updatedAt = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .from('comments')
    .update({ content: input.content, updated_at: updatedAt })
    .eq('id', input.commentId)
    .eq('post_id', input.postId)
    .eq('user_id', input.userId)
    .is('deleted_at', null)
    .select()
    .maybeSingle()

  if (updateError) fail(operation, 'source-update', 'database', updateError)
  const result = parseUpdatedComment(updated ? [updated] : updated, input)
  if (!result) fail(operation, 'source-ack', 'conflict')
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

  if (!error) {
    const result = parseDeleteOwnComment(data)
    if (!result) fail(operation, 'rpc-ack', 'database')
    return result
  }
  if (!isMissingDatabaseFunction(error)) failForRpc(operation, error)

  logger.warn('[comment mutation rollout] RPC missing; using legacy path', {
    operation,
    code: error.code,
  })
  const [{ data: post, error: postError }, { data: comment, error: commentError }] =
    await Promise.all([
      supabase.from('posts').select('id').eq('id', input.postId).maybeSingle(),
      supabase
        .from('comments')
        .select('id, post_id, user_id, parent_id, deleted_at')
        .eq('id', input.commentId)
        .maybeSingle(),
    ])

  if (postError) fail(operation, 'post-read', 'database', postError)
  if (commentError) fail(operation, 'comment-read', 'database', commentError)
  if (!post || !comment || comment.post_id !== input.postId || comment.deleted_at) {
    fail(operation, 'resource-read', 'not_found')
  }
  if (comment.user_id !== input.userId) fail(operation, 'ownership', 'forbidden')

  let subtreeQuery = supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', input.postId)
    .is('deleted_at', null)
  subtreeQuery = comment.parent_id
    ? subtreeQuery.eq('id', input.commentId)
    : subtreeQuery.or(`id.eq.${input.commentId},parent_id.eq.${input.commentId}`)
  const { count: deletedCount, error: subtreeError } = await subtreeQuery

  if (subtreeError) fail(operation, 'subtree-count', 'database', subtreeError)
  if (!Number.isSafeInteger(deletedCount) || (deletedCount as number) <= 0) {
    fail(operation, 'subtree-count', 'conflict')
  }

  const { data: deleted, error: deleteError } = await supabase
    .from('comments')
    .delete()
    .eq('id', input.commentId)
    .eq('post_id', input.postId)
    .eq('user_id', input.userId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle()

  if (deleteError) fail(operation, 'source-delete', 'database', deleteError)
  if (!deleted || deleted.id !== input.commentId) {
    fail(operation, 'source-ack', 'conflict')
  }

  const commentCount = await updateCommentCountFromSource(supabase, input.postId, operation)
  return { deleted_count: deletedCount as number, comment_count: commentCount }
}

type LegacyModerationComment = {
  id: string
  post_id: string
  parent_id: string | null
  deleted_at: string | null
  deleted_by: string | null
  delete_reason: string | null
}

type DeletionMarker = {
  deleted_at: string
  deleted_by: string | null
  delete_reason: string | null
}

function parseLegacyModerationComment(value: unknown): LegacyModerationComment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.post_id !== 'string' ||
    (candidate.parent_id !== null && typeof candidate.parent_id !== 'string') ||
    (candidate.deleted_at !== null && typeof candidate.deleted_at !== 'string') ||
    (typeof candidate.deleted_at === 'string' &&
      !Number.isFinite(Date.parse(candidate.deleted_at))) ||
    (candidate.deleted_by !== null && typeof candidate.deleted_by !== 'string') ||
    (candidate.delete_reason !== null && typeof candidate.delete_reason !== 'string')
  ) {
    return null
  }
  return candidate as LegacyModerationComment
}

function matchesDeletionMarker(value: unknown, marker: DeletionMarker): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.deleted_at === marker.deleted_at &&
    candidate.deleted_by === marker.deleted_by &&
    candidate.delete_reason === marker.delete_reason
  )
}

function parseLegacyModerationRows(
  value: unknown,
  input: {
    commentId: string
    postId: string
    parentId: string | null
    marker: DeletionMarker | null
  }
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const seenIds = new Set<string>()
  let includesTarget = false
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const candidate = row as Record<string, unknown>
    if (
      typeof candidate.id !== 'string' ||
      seenIds.has(candidate.id) ||
      candidate.post_id !== input.postId ||
      (candidate.id !== input.commentId &&
        (input.parentId !== null || candidate.parent_id !== input.commentId))
    ) {
      return null
    }

    if (input.marker) {
      if (!matchesDeletionMarker(candidate, input.marker)) return null
    } else if (
      candidate.deleted_at !== null ||
      candidate.deleted_by !== null ||
      candidate.delete_reason !== null
    ) {
      return null
    }

    seenIds.add(candidate.id)
    if (candidate.id === input.commentId) includesTarget = true
  }

  return includesTarget ? (value as Array<Record<string, unknown>>) : null
}

async function readLegacyModerationResource(
  supabase: SupabaseClient,
  input: ModerateCommentInput,
  operation: string
): Promise<LegacyModerationComment> {
  const { data, error } = await supabase
    .from('comments')
    .select('id, post_id, parent_id, deleted_at, deleted_by, delete_reason')
    .eq('id', input.commentId)
    .maybeSingle()

  if (error) fail(operation, 'comment-read', 'database', error)
  const comment = parseLegacyModerationComment(data)
  if (
    !comment ||
    comment.id !== input.commentId ||
    (input.expectedPostId && comment.post_id !== input.expectedPostId)
  ) {
    fail(operation, 'comment-read', 'not_found')
  }

  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id')
    .eq('id', comment.post_id)
    .maybeSingle()

  if (postError) fail(operation, 'post-read', 'database', postError)
  if (!post || post.id !== comment.post_id) fail(operation, 'post-read', 'not_found')
  return comment
}

async function legacyHardDeleteComment(
  supabase: SupabaseClient,
  comment: LegacyModerationComment,
  operation: string
): Promise<ModerateCommentResult> {
  let activeQuery = supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', comment.post_id)
    .is('deleted_at', null)
  activeQuery = comment.parent_id
    ? activeQuery.eq('id', comment.id)
    : activeQuery.or(`id.eq.${comment.id},parent_id.eq.${comment.id}`)
  const { count, error: countError } = await activeQuery

  if (countError) fail(operation, 'subtree-count', 'database', countError)
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    fail(operation, 'subtree-count', 'database')
  }

  const { data: deleted, error: deleteError } = await supabase
    .from('comments')
    .delete()
    .eq('id', comment.id)
    .eq('post_id', comment.post_id)
    .select('id')
    .maybeSingle()

  if (deleteError) fail(operation, 'source-delete', 'database', deleteError)
  if (!deleted || deleted.id !== comment.id) fail(operation, 'source-ack', 'conflict')

  const commentCount = await updateCommentCountFromSource(supabase, comment.post_id, operation)
  return {
    post_id: comment.post_id,
    affected_count: count as number,
    comment_count: commentCount,
  }
}

async function legacySoftDeleteComment(
  supabase: SupabaseClient,
  comment: LegacyModerationComment,
  input: ModerateCommentInput,
  operation: string
): Promise<ModerateCommentResult> {
  if (comment.deleted_at) {
    const commentCount = await updateCommentCountFromSource(supabase, comment.post_id, operation)
    return { post_id: comment.post_id, affected_count: 0, comment_count: commentCount }
  }

  const marker: DeletionMarker = {
    deleted_at: new Date().toISOString(),
    deleted_by: input.actorId,
    delete_reason: input.reason,
  }
  let mutation = supabase
    .from('comments')
    .update(marker)
    .eq('post_id', comment.post_id)
    .is('deleted_at', null)
  mutation = comment.parent_id
    ? mutation.eq('id', comment.id)
    : mutation.or(`id.eq.${comment.id},parent_id.eq.${comment.id}`)
  const { data: updated, error: updateError } = await mutation.select(
    'id, post_id, parent_id, deleted_at, deleted_by, delete_reason'
  )

  if (updateError) fail(operation, 'source-update', 'database', updateError)
  const rows = parseLegacyModerationRows(updated, {
    commentId: comment.id,
    postId: comment.post_id,
    parentId: comment.parent_id,
    marker,
  })
  if (!rows) fail(operation, 'source-ack', 'conflict')

  const commentCount = await updateCommentCountFromSource(supabase, comment.post_id, operation)
  return {
    post_id: comment.post_id,
    affected_count: rows.length,
    comment_count: commentCount,
  }
}

async function legacyRestoreAutoHiddenComment(
  supabase: SupabaseClient,
  comment: LegacyModerationComment,
  operation: string
): Promise<ModerateCommentResult> {
  if (!comment.deleted_at) {
    const commentCount = await updateCommentCountFromSource(supabase, comment.post_id, operation)
    return { post_id: comment.post_id, affected_count: 0, comment_count: commentCount }
  }

  // Queue approval must not undo an unrelated administrator deletion. Mirror
  // the expand RPC's locked marker contract during the legacy window.
  if (
    comment.deleted_by !== null ||
    comment.delete_reason === null ||
    !comment.delete_reason.startsWith('Auto-hidden:')
  ) {
    fail(operation, 'restore-marker', 'forbidden')
  }

  const oldMarker: DeletionMarker = {
    deleted_at: comment.deleted_at,
    deleted_by: comment.deleted_by,
    delete_reason: comment.delete_reason,
  }
  let mutation = supabase
    .from('comments')
    .update({ deleted_at: null, deleted_by: null, delete_reason: null })
    .eq('post_id', comment.post_id)
    .eq('deleted_at', oldMarker.deleted_at)
  mutation =
    oldMarker.deleted_by === null
      ? mutation.is('deleted_by', null)
      : mutation.eq('deleted_by', oldMarker.deleted_by)
  mutation =
    oldMarker.delete_reason === null
      ? mutation.is('delete_reason', null)
      : mutation.eq('delete_reason', oldMarker.delete_reason)
  mutation = comment.parent_id
    ? mutation.eq('id', comment.id)
    : mutation.or(`id.eq.${comment.id},parent_id.eq.${comment.id}`)
  const { data: restored, error: restoreError } = await mutation.select(
    'id, post_id, parent_id, deleted_at, deleted_by, delete_reason'
  )

  if (restoreError) fail(operation, 'source-update', 'database', restoreError)
  const rows = parseLegacyModerationRows(restored, {
    commentId: comment.id,
    postId: comment.post_id,
    parentId: comment.parent_id,
    marker: null,
  })
  if (!rows) fail(operation, 'source-ack', 'conflict')

  const commentCount = await updateCommentCountFromSource(supabase, comment.post_id, operation)
  return {
    post_id: comment.post_id,
    affected_count: rows.length,
    comment_count: commentCount,
  }
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

  if (!error) {
    const result = parseModerateComment(data)
    if (!result) fail(operation, 'rpc-ack', 'database')
    if (input.expectedPostId && result.post_id !== input.expectedPostId) {
      fail(operation, 'rpc-resource-ack', 'conflict')
    }
    return result
  }
  if (!isMissingDatabaseFunction(error)) failForRpc(operation, error)

  logger.warn('[comment mutation rollout] RPC missing; using legacy path', {
    operation,
    action: input.action,
    code: error.code,
  })
  const comment = await readLegacyModerationResource(supabase, input, operation)
  if (input.action === 'hard_delete') {
    return legacyHardDeleteComment(supabase, comment, operation)
  }
  if (input.action === 'soft_delete') {
    return legacySoftDeleteComment(supabase, comment, input, operation)
  }
  return legacyRestoreAutoHiddenComment(supabase, comment, operation)
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
