/**
 * 评论数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  CommentMutationRolloutError,
  deleteOwnCommentWithRollout,
  updateOwnCommentWithRollout,
  type UpdatedComment,
} from '@/lib/data/comment-mutation-rollout'
import { logger } from '@/lib/logger'

export interface Comment {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string
  like_count: number
  dislike_count: number
  created_at: string
  updated_at: string
  author_handle?: string
  author_avatar_url?: string
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  user_liked?: boolean
  user_disliked?: boolean
  replies?: Comment[]
}

export interface CreateCommentInput {
  post_id: string
  content: string
  parent_id?: string
}

interface CommentRow {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string | null
  like_count?: number
  dislike_count?: number
  created_at: string
  updated_at: string
}

interface AuthorProfile {
  handle: string
  avatar_url: string | null
  is_pro: boolean
  show_pro_badge: boolean
}

/**
 * 转换数据库行为 Comment 对象
 */
function toComment(
  row: CommentRow,
  profile?: AuthorProfile,
  userLiked = false,
  userDisliked = false,
  replies: Comment[] = []
): Comment {
  return {
    id: row.id,
    post_id: row.post_id,
    user_id: row.user_id,
    content: row.content,
    parent_id: row.parent_id ?? undefined,
    like_count: row.like_count || 0,
    dislike_count: row.dislike_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author_handle: profile?.handle,
    author_avatar_url: profile?.avatar_url ?? undefined,
    author_is_pro: profile?.is_pro ?? false,
    author_show_pro_badge: profile?.show_pro_badge !== false,
    user_liked: userLiked,
    user_disliked: userDisliked,
    replies,
  }
}

function toCommentFromMutationAck(value: UpdatedComment): Comment {
  if (
    typeof value.created_at !== 'string' ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    (value.parent_id !== null &&
      value.parent_id !== undefined &&
      typeof value.parent_id !== 'string') ||
    (value.like_count !== undefined &&
      (!Number.isSafeInteger(value.like_count) || (value.like_count as number) < 0)) ||
    (value.dislike_count !== undefined &&
      (!Number.isSafeInteger(value.dislike_count) || (value.dislike_count as number) < 0))
  ) {
    throw new CommentMutationRolloutError('database', undefined, 'data-layer-ack')
  }

  return toComment({
    id: value.id,
    post_id: value.post_id,
    user_id: value.user_id,
    content: value.content,
    parent_id: value.parent_id as string | null | undefined,
    like_count: value.like_count as number | undefined,
    dislike_count: value.dislike_count as number | undefined,
    created_at: value.created_at,
    updated_at: value.updated_at,
  })
}

async function getOwnedActiveCommentPostId(
  supabase: SupabaseClient,
  commentId: string,
  userId: string
): Promise<string> {
  const { data, error } = await supabase
    .from('comments')
    .select('id, post_id, user_id, deleted_at')
    .eq('id', commentId)
    .maybeSingle()

  if (error) {
    throw new CommentMutationRolloutError('database', error.code, 'data-layer-read')
  }
  if (!data) {
    throw new CommentMutationRolloutError('not_found', undefined, 'data-layer-read')
  }
  if (
    data.id !== commentId ||
    typeof data.post_id !== 'string' ||
    data.post_id.length === 0 ||
    typeof data.user_id !== 'string' ||
    (data.deleted_at !== null && typeof data.deleted_at !== 'string') ||
    (typeof data.deleted_at === 'string' && !Number.isFinite(Date.parse(data.deleted_at)))
  ) {
    throw new CommentMutationRolloutError('database', undefined, 'data-layer-read-ack')
  }
  if (data.deleted_at !== null) {
    throw new CommentMutationRolloutError('not_found', undefined, 'data-layer-read')
  }
  if (data.user_id !== userId) {
    throw new CommentMutationRolloutError('forbidden', undefined, 'data-layer-ownership')
  }
  return data.post_id
}

/**
 * 构建作者资料映射
 */
function buildProfileMap(
  profiles: Array<{
    id: string
    handle: string
    avatar_url: string | null
    subscription_tier?: string | null
    show_pro_badge?: boolean | null
  }>
): Map<string, AuthorProfile> {
  const map = new Map<string, AuthorProfile>()
  for (const p of profiles) {
    map.set(p.id, {
      handle: p.handle,
      avatar_url: p.avatar_url,
      is_pro: p.subscription_tier === 'pro',
      show_pro_badge: p.show_pro_badge !== false,
    })
  }
  return map
}

export type CommentSortMode = 'best' | 'time'

/**
 * 获取帖子的评论列表
 */
export async function getPostComments(
  supabase: SupabaseClient,
  postId: string,
  options: { limit?: number; offset?: number; userId?: string; sort?: CommentSortMode } = {}
): Promise<Comment[]> {
  const { limit = 50, offset = 0, userId, sort = 'best' } = options

  // Resolve blocks before pagination. Filtering a ranged page in JavaScript
  // produces short/empty pages and incorrect has_more values, and used to leak
  // replies written by blocked users.
  const blockedIds = new Set<string>()
  if (userId) {
    const { data: blocks, error: blocksError } = await supabase
      .from('blocked_users')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)

    if (blocksError) throw blocksError
    for (const block of blocks || []) {
      blockedIds.add(block.blocker_id === userId ? block.blocked_id : block.blocker_id)
    }
  }

  let query = supabase
    .from('comments')
    .select(
      'id, post_id, user_id, content, parent_id, like_count, dislike_count, created_at, updated_at'
    )
    .eq('post_id', postId)
    .is('parent_id', null)
    .is('deleted_at', null) // hide soft-deleted (auto-moderated) comments

  if (blockedIds.size > 0) {
    query = query.not('user_id', 'in', `(${[...blockedIds].join(',')})`)
  }

  if (sort === 'time') {
    query = query.order('created_at', { ascending: false }).order('id', { ascending: false })
  } else {
    // ranking_score is a stored generated Wilson lower-bound column. Ordering
    // before range makes ranking correct across the complete comment set.
    query = query
      .order('ranking_score', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
  }

  query = query.range(offset, offset + limit - 1)

  const { data: comments, error } = await query

  if (error) throw error
  if (!comments || comments.length === 0) return []

  const commentIds = comments.map((c) => c.id)
  let repliesQuery = supabase
    .from('comments')
    .select(
      'id, post_id, user_id, content, parent_id, like_count, dislike_count, created_at, updated_at'
    )
    .in('parent_id', commentIds)
    .is('deleted_at', null) // hide soft-deleted (auto-moderated) replies

  if (blockedIds.size > 0) {
    repliesQuery = repliesQuery.not('user_id', 'in', `(${[...blockedIds].join(',')})`)
  }

  const { data: replies, error: repliesError } = await repliesQuery
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (repliesError)
    logger.warn('[getPostComments] comment replies query error (drift?):', repliesError.message)

  const allComments = [...comments, ...(replies || [])]
  const userIds = [...new Set(allComments.map((c) => c.user_id))]
  const allCommentIds = allComments.map((c) => c.id)

  const [profilesResult, likesResult] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
      .in('id', userIds),
    userId
      ? supabase
          .from('comment_likes')
          .select('comment_id, reaction_type')
          .eq('user_id', userId)
          .in('comment_id', allCommentIds)
      : Promise.resolve({ data: null }),
  ])

  const profileMap = profilesResult.data ? buildProfileMap(profilesResult.data) : new Map()
  const userLikedSet = new Set<string>()
  const userDislikedSet = new Set<string>()
  for (const r of likesResult.data || []) {
    const reaction = r as { comment_id: string; reaction_type?: string }
    if (reaction.reaction_type === 'dislike') {
      userDislikedSet.add(reaction.comment_id)
    } else {
      userLikedSet.add(reaction.comment_id)
    }
  }

  const repliesMap = new Map<string, Comment[]>()
  for (const reply of replies || []) {
    if (!reply.parent_id) continue
    const comment = toComment(
      reply,
      profileMap.get(reply.user_id),
      userLikedSet.has(reply.id),
      userDislikedSet.has(reply.id)
    )
    const parentReplies = repliesMap.get(reply.parent_id) || []
    parentReplies.push(comment)
    repliesMap.set(reply.parent_id, parentReplies)
  }

  return comments.map((c: CommentRow) =>
    toComment(
      c,
      profileMap.get(c.user_id),
      userLikedSet.has(c.id),
      userDislikedSet.has(c.id),
      repliesMap.get(c.id) || []
    )
  )
}

/**
 * 获取单个评论
 */
export async function getCommentById(
  supabase: SupabaseClient,
  commentId: string
): Promise<Comment | null> {
  const { data, error } = await supabase
    .from('comments')
    .select(
      'id, post_id, user_id, content, parent_id, like_count, dislike_count, created_at, updated_at'
    )
    .eq('id', commentId)
    .is('deleted_at', null) // hide soft-deleted (auto-moderated) comments
    .maybeSingle()

  if (error || !data) return null

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
    .eq('id', data.user_id)
    .maybeSingle()
  if (profileError)
    logger.warn('[getCommentById] user_profiles query error (drift?):', profileError.message)

  const profileMap = profile ? buildProfileMap([profile]) : new Map()
  return toComment(data, profileMap.get(data.user_id))
}

/**
 * 创建评论
 */
export async function createComment(
  supabase: SupabaseClient,
  userId: string,
  input: CreateCommentInput
): Promise<Comment> {
  // Sanitize comment content to prevent XSS (matches post sanitization pattern)
  const { sanitizeText } = await import('@/lib/utils/sanitize')
  const safeContent = sanitizeText(input.content, { preserveNewlines: true, maxLength: 2000 })

  const { data, error } = await supabase
    .from('comments')
    .insert({
      post_id: input.post_id,
      user_id: userId,
      content: safeContent,
      parent_id: input.parent_id || null,
    })
    .select()
    .single()

  if (error) throw error

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
    .eq('id', userId)
    .maybeSingle()
  if (profileError)
    logger.warn('[createComment] user_profiles query error (drift?):', profileError.message)

  const profileMap = profile ? buildProfileMap([profile]) : new Map()
  return toComment(data, profileMap.get(userId))
}

/**
 * 更新评论
 */
export async function updateComment(
  supabase: SupabaseClient,
  commentId: string,
  userId: string,
  content: string
): Promise<Comment> {
  const { sanitizeText } = await import('@/lib/utils/sanitize')
  const safeContent = sanitizeText(content, { preserveNewlines: true, maxLength: 2000 })
  const postId = await getOwnedActiveCommentPostId(supabase, commentId, userId)
  const updated = await updateOwnCommentWithRollout(supabase, {
    commentId,
    postId,
    userId,
    content: safeContent,
  })
  return toCommentFromMutationAck(updated)
}

/**
 * 删除评论
 */
export async function deleteComment(
  supabase: SupabaseClient,
  commentId: string,
  userId: string
): Promise<void> {
  const postId = await getOwnedActiveCommentPostId(supabase, commentId, userId)
  await deleteOwnCommentWithRollout(supabase, { commentId, postId, userId })
}

/**
 * 获取评论数量
 */
export async function getCommentCount(supabase: SupabaseClient, postId: string): Promise<number> {
  // KEEP 'exact' — scoped to a single post via (post_id) index and
  // shown as the exact comment count on the post card. Per-post row
  // sets are small (<<1k typical) so the count is cheap.
  const { count, error } = await supabase
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', postId)
    .is('deleted_at', null) // exclude soft-deleted (auto-moderated) comments

  if (error) return 0
  return count || 0
}
