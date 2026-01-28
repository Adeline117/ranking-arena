/**
 * 评论数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'

export interface Comment {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string
  like_count: number
  created_at: string
  updated_at: string
  author_handle?: string
  author_avatar_url?: string
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  user_liked?: boolean
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
  replies: Comment[] = []
): Comment {
  return {
    id: row.id,
    post_id: row.post_id,
    user_id: row.user_id,
    content: row.content,
    parent_id: row.parent_id ?? undefined,
    like_count: row.like_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author_handle: profile?.handle,
    author_avatar_url: profile?.avatar_url ?? undefined,
    author_is_pro: profile?.is_pro ?? false,
    author_show_pro_badge: profile?.show_pro_badge !== false,
    user_liked: userLiked,
    replies,
  }
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

/**
 * 对评论进行自定义排序：前3条按点赞数降序，其余按时间升序
 */
function sortComments(comments: CommentRow[]): CommentRow[] {
  const byLikes = [...comments].sort((a, b) => (b.like_count || 0) - (a.like_count || 0))
  const top3 = byLikes.slice(0, 3)
  const top3Ids = new Set(top3.map(c => c.id))
  const rest = comments
    .filter(c => !top3Ids.has(c.id))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  return [...top3, ...rest]
}

/**
 * 获取帖子的评论列表
 */
export async function getPostComments(
  supabase: SupabaseClient,
  postId: string,
  options: { limit?: number; offset?: number; userId?: string } = {}
): Promise<Comment[]> {
  const { limit = 50, offset = 0, userId } = options

  const { data: allTopComments, error } = await supabase
    .from('comments')
    .select('*')
    .eq('post_id', postId)
    .is('parent_id', null)

  if (error) throw error
  if (!allTopComments || allTopComments.length === 0) return []

  const comments = sortComments(allTopComments).slice(offset, offset + limit)
  if (comments.length === 0) return []

  const commentIds = comments.map(c => c.id)
  const { data: replies } = await supabase
    .from('comments')
    .select('*')
    .in('parent_id', commentIds)
    .order('created_at', { ascending: true })

  const allComments = [...comments, ...(replies || [])]
  const userIds = [...new Set(allComments.map(c => c.user_id))]
  const allCommentIds = allComments.map(c => c.id)

  const [profilesResult, likesResult] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
      .in('id', userIds),
    userId
      ? supabase.from('comment_likes').select('comment_id').eq('user_id', userId).in('comment_id', allCommentIds)
      : Promise.resolve({ data: null }),
  ])

  const profileMap = profilesResult.data ? buildProfileMap(profilesResult.data) : new Map()
  const userLikedSet = new Set(likesResult.data?.map((like: { comment_id: string }) => like.comment_id) || [])

  const repliesMap = new Map<string, Comment[]>()
  for (const reply of replies || []) {
    if (!reply.parent_id) continue
    const comment = toComment(reply, profileMap.get(reply.user_id), userLikedSet.has(reply.id))
    const parentReplies = repliesMap.get(reply.parent_id) || []
    parentReplies.push(comment)
    repliesMap.set(reply.parent_id, parentReplies)
  }

  return comments.map((c: CommentRow) =>
    toComment(c, profileMap.get(c.user_id), userLikedSet.has(c.id), repliesMap.get(c.id) || [])
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
    .select('*')
    .eq('id', commentId)
    .maybeSingle()

  if (error || !data) return null

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
    .eq('id', data.user_id)
    .maybeSingle()

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
  const { data, error } = await supabase
    .from('comments')
    .insert({
      post_id: input.post_id,
      user_id: userId,
      content: input.content,
      parent_id: input.parent_id || null,
    })
    .select()
    .single()

  if (error) throw error

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
    .eq('id', userId)
    .maybeSingle()

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
  const { data, error } = await supabase
    .from('comments')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', commentId)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return toComment(data)
}

/**
 * 删除评论
 */
export async function deleteComment(
  supabase: SupabaseClient,
  commentId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('comments')
    .delete()
    .eq('id', commentId)
    .eq('user_id', userId)

  if (error) throw error
}

/**
 * 获取评论数量
 */
export async function getCommentCount(
  supabase: SupabaseClient,
  postId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('comments')
    .select('*', { count: 'exact', head: true })
    .eq('post_id', postId)

  if (error) return 0
  return count || 0
}

