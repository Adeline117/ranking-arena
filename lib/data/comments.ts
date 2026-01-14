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
  // 关联信息
  author_handle?: string
  author_avatar_url?: string
  // 用户状态
  user_liked?: boolean
  // 嵌套回复
  replies?: Comment[]
}

export interface CreateCommentInput {
  post_id: string
  content: string
  parent_id?: string
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

  // 获取顶级评论
  const { data: comments, error } = await supabase
    .from('comments')
    .select('*')
    .eq('post_id', postId)
    .is('parent_id', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error('[comments] 获取评论失败:', error)
    throw error
  }

  if (!comments || comments.length === 0) return []

  // 获取所有回复
  const commentIds = comments.map(c => c.id)
  const { data: replies } = await supabase
    .from('comments')
    .select('*')
    .in('parent_id', commentIds)
    .order('created_at', { ascending: true })

  // 获取所有用户ID
  const allComments = [...comments, ...(replies || [])]
  const userIds = [...new Set(allComments.map(c => c.user_id))]

  // 获取用户信息
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .in('id', userIds)

  const profileMap = new Map<string, { handle: string; avatar_url: string | null }>()
  if (profiles) {
    profiles.forEach((p: { id: string; handle: string; avatar_url: string | null }) => {
      profileMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
    })
  }

  // 获取用户对评论的点赞状态
  const userLikedMap = new Map<string, boolean>()
  if (userId) {
    const allCommentIds = allComments.map(c => c.id)
    const { data: likes } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', userId)
      .in('comment_id', allCommentIds)
    
    if (likes) {
      likes.forEach((like: { comment_id: string }) => {
        userLikedMap.set(like.comment_id, true)
      })
    }
  }

  // 构建回复映射
  const repliesMap = new Map<string, Comment[]>()
  if (replies) {
    replies.forEach((reply: any) => {
      const profile = profileMap.get(reply.user_id)
      const comment: Comment = {
        id: reply.id,
        post_id: reply.post_id,
        user_id: reply.user_id,
        content: reply.content,
        parent_id: reply.parent_id,
        like_count: reply.like_count || 0,
        created_at: reply.created_at,
        updated_at: reply.updated_at,
        author_handle: profile?.handle,
        author_avatar_url: profile?.avatar_url || undefined,
        user_liked: userLikedMap.get(reply.id) || false,
      }

      const parentReplies = repliesMap.get(reply.parent_id) || []
      parentReplies.push(comment)
      repliesMap.set(reply.parent_id, parentReplies)
    })
  }

  // 构建结果
  return comments.map((c: any) => {
    const profile = profileMap.get(c.user_id)
    return {
      id: c.id,
      post_id: c.post_id,
      user_id: c.user_id,
      content: c.content,
      parent_id: c.parent_id,
      like_count: c.like_count || 0,
      created_at: c.created_at,
      updated_at: c.updated_at,
      author_handle: profile?.handle,
      author_avatar_url: profile?.avatar_url || undefined,
      user_liked: userLikedMap.get(c.id) || false,
      replies: repliesMap.get(c.id) || [],
    }
  })
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

  // 获取用户信息
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handle, avatar_url')
    .eq('id', data.user_id)
    .maybeSingle()

  return {
    id: data.id,
    post_id: data.post_id,
    user_id: data.user_id,
    content: data.content,
    parent_id: data.parent_id,
    like_count: data.like_count || 0,
    created_at: data.created_at,
    updated_at: data.updated_at,
    author_handle: profile?.handle,
    author_avatar_url: profile?.avatar_url || undefined,
  }
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

  if (error) {
    console.error('[comments] 创建评论失败:', error)
    throw error
  }

  // 获取用户信息
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handle, avatar_url')
    .eq('id', userId)
    .maybeSingle()

  return {
    id: data.id,
    post_id: data.post_id,
    user_id: data.user_id,
    content: data.content,
    parent_id: data.parent_id,
    like_count: 0,
    created_at: data.created_at,
    updated_at: data.updated_at,
    author_handle: profile?.handle,
    author_avatar_url: profile?.avatar_url || undefined,
  }
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
    .update({
      content,
      updated_at: new Date().toISOString(),
    })
    .eq('id', commentId)
    .eq('user_id', userId) // 确保只能更新自己的评论
    .select()
    .single()

  if (error) {
    console.error('[comments] 更新评论失败:', error)
    throw error
  }

  return data
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
    .eq('user_id', userId) // 确保只能删除自己的评论

  if (error) {
    console.error('[comments] 删除评论失败:', error)
    throw error
  }
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

