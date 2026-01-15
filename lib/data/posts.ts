/**
 * 帖子数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'

export interface Post {
  id: string
  title: string
  content: string
  author_id: string
  author_handle: string
  group_id?: string
  group_name?: string
  poll_enabled: boolean
  poll_bull: number
  poll_bear: number
  poll_wait: number
  like_count: number
  dislike_count: number
  comment_count: number
  view_count: number
  hot_score: number
  is_pinned: boolean
  created_at: string
  updated_at?: string
}

export interface PostWithAuthor extends Post {
  author_avatar_url?: string
}

export interface CreatePostInput {
  title: string
  content: string
  group_id?: string
  poll_enabled?: boolean
}

export interface PostListOptions {
  limit?: number
  offset?: number
  group_id?: string
  author_handle?: string
  sort_by?: 'created_at' | 'hot_score' | 'like_count'
  sort_order?: 'asc' | 'desc'
}

/**
 * 获取帖子列表
 */
export async function getPosts(
  supabase: SupabaseClient,
  options: PostListOptions = {}
): Promise<PostWithAuthor[]> {
  const {
    limit = 20,
    offset = 0,
    group_id,
    author_handle,
    sort_by = 'created_at',
    sort_order = 'desc',
  } = options

  let query = supabase
    .from('posts')
    .select(`
      id,
      title,
      content,
      author_id,
      author_handle,
      group_id,
      poll_enabled,
      poll_id,
      poll_bull,
      poll_bear,
      poll_wait,
      like_count,
      dislike_count,
      comment_count,
      view_count,
      hot_score,
      is_pinned,
      images,
      created_at,
      updated_at,
      groups(name)
    `)
    .range(offset, offset + limit - 1)
    .order(sort_by, { ascending: sort_order === 'asc' })

  if (group_id) {
    query = query.eq('group_id', group_id)
  }

  if (author_handle) {
    query = query.eq('author_handle', author_handle)
  }

  const { data, error } = await query

  if (error) {
    console.error('[posts] 获取帖子列表失败:', error)
    throw error
  }

  // 获取作者头像
  const authorHandles = [...new Set((data || []).map(p => p.author_handle).filter(Boolean))]
  const avatarMap = new Map<string, string>()

  if (authorHandles.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('handle, avatar_url')
      .in('handle', authorHandles)

    if (profiles) {
      profiles.forEach((p: { handle: string; avatar_url: string | null }) => {
        if (p.avatar_url) {
          avatarMap.set(p.handle, p.avatar_url)
        }
      })
    }
  }

  return (data || []).map((post: any) => ({
    id: post.id,
    title: post.title,
    content: post.content,
    author_id: post.author_id,
    author_handle: post.author_handle,
    author_avatar_url: avatarMap.get(post.author_handle),
    group_id: post.group_id,
    group_name: post.groups?.name,
    poll_enabled: post.poll_enabled || false,
    poll_id: post.poll_id || null,
    poll_bull: post.poll_bull || 0,
    poll_bear: post.poll_bear || 0,
    poll_wait: post.poll_wait || 0,
    like_count: post.like_count || 0,
    dislike_count: post.dislike_count || 0,
    comment_count: post.comment_count || 0,
    view_count: post.view_count || 0,
    hot_score: post.hot_score || 0,
    is_pinned: post.is_pinned || false,
    images: post.images || null,
    created_at: post.created_at,
    updated_at: post.updated_at,
  }))
}

/**
 * 获取单个帖子
 */
export async function getPostById(
  supabase: SupabaseClient,
  postId: string
): Promise<PostWithAuthor | null> {
  const { data, error } = await supabase
    .from('posts')
    .select(`
      id,
      title,
      content,
      author_id,
      author_handle,
      group_id,
      poll_enabled,
      poll_bull,
      poll_bear,
      poll_wait,
      like_count,
      dislike_count,
      comment_count,
      view_count,
      hot_score,
      is_pinned,
      created_at,
      updated_at,
      groups(name)
    `)
    .eq('id', postId)
    .maybeSingle()

  if (error) {
    console.error('[posts] 获取帖子失败:', error)
    throw error
  }

  if (!data) return null

  // 获取作者头像
  let author_avatar_url: string | undefined
  if (data.author_handle) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('avatar_url')
      .eq('handle', data.author_handle)
      .maybeSingle()
    
    author_avatar_url = profile?.avatar_url || undefined
  }

  return {
    id: data.id,
    title: data.title,
    content: data.content,
    author_id: data.author_id,
    author_handle: data.author_handle,
    author_avatar_url,
    group_id: data.group_id,
    group_name: (data as any).groups?.name,
    poll_enabled: data.poll_enabled || false,
    poll_bull: data.poll_bull || 0,
    poll_bear: data.poll_bear || 0,
    poll_wait: data.poll_wait || 0,
    like_count: data.like_count || 0,
    dislike_count: data.dislike_count || 0,
    comment_count: data.comment_count || 0,
    view_count: data.view_count || 0,
    hot_score: data.hot_score || 0,
    is_pinned: data.is_pinned || false,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

/**
 * 创建帖子
 */
export async function createPost(
  supabase: SupabaseClient,
  userId: string,
  userHandle: string,
  input: CreatePostInput
): Promise<Post> {
  const { data, error } = await supabase
    .from('posts')
    .insert({
      title: input.title,
      content: input.content,
      author_id: userId,
      author_handle: userHandle,
      group_id: input.group_id || null,
      poll_enabled: input.poll_enabled || false,
    })
    .select()
    .single()

  if (error) {
    console.error('[posts] 创建帖子失败:', error)
    throw error
  }

  return data
}

/**
 * 更新帖子
 */
export async function updatePost(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  updates: { title?: string; content?: string; poll_enabled?: boolean }
): Promise<Post> {
  const { data, error } = await supabase
    .from('posts')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', postId)
    .eq('author_id', userId) // 确保只能更新自己的帖子
    .select()
    .single()

  if (error) {
    console.error('[posts] 更新帖子失败:', error)
    throw error
  }

  return data
}

/**
 * 删除帖子
 */
export async function deletePost(
  supabase: SupabaseClient,
  postId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('posts')
    .delete()
    .eq('id', postId)
    .eq('author_id', userId) // 确保只能删除自己的帖子

  if (error) {
    console.error('[posts] 删除帖子失败:', error)
    throw error
  }
}

/**
 * 增加浏览次数
 */
export async function incrementViewCount(
  supabase: SupabaseClient,
  postId: string
): Promise<void> {
  const { error } = await supabase.rpc('increment_post_view', { post_id: postId })
  
  // 如果 RPC 不存在，直接更新
  if (error) {
    await supabase
      .from('posts')
      .update({ view_count: supabase.rpc('coalesce', { value: 0 }) })
      .eq('id', postId)
  }
}

/**
 * 获取用户对帖子的点赞状态
 */
export async function getUserPostReaction(
  supabase: SupabaseClient,
  postId: string,
  userId: string
): Promise<'up' | 'down' | null> {
  const { data, error } = await supabase
    .from('post_likes')
    .select('reaction_type')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data) return null
  return data.reaction_type as 'up' | 'down'
}

/**
 * 点赞/踩帖子
 */
export async function togglePostReaction(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  reactionType: 'up' | 'down'
): Promise<{ action: 'added' | 'removed' | 'changed'; reaction: 'up' | 'down' | null }> {
  // 检查是否已有反应
  const { data: existing } = await supabase
    .from('post_likes')
    .select('id, reaction_type')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    if (existing.reaction_type === reactionType) {
      // 取消点赞/踩
      await supabase
        .from('post_likes')
        .delete()
        .eq('id', existing.id)
      return { action: 'removed', reaction: null }
    } else {
      // 切换点赞/踩
      await supabase
        .from('post_likes')
        .update({ reaction_type: reactionType })
        .eq('id', existing.id)
      return { action: 'changed', reaction: reactionType }
    }
  } else {
    // 新增点赞/踩
    await supabase
      .from('post_likes')
      .insert({
        post_id: postId,
        user_id: userId,
        reaction_type: reactionType,
      })
    return { action: 'added', reaction: reactionType }
  }
}

/**
 * 获取用户对帖子的投票
 */
export async function getUserPostVote(
  supabase: SupabaseClient,
  postId: string,
  userId: string
): Promise<'bull' | 'bear' | 'wait' | null> {
  const { data, error } = await supabase
    .from('post_votes')
    .select('choice')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data) return null
  return data.choice as 'bull' | 'bear' | 'wait'
}

/**
 * 投票
 */
export async function togglePostVote(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  choice: 'bull' | 'bear' | 'wait'
): Promise<{ action: 'added' | 'removed' | 'changed'; vote: 'bull' | 'bear' | 'wait' | null }> {
  // 检查是否已有投票
  const { data: existing } = await supabase
    .from('post_votes')
    .select('id, choice')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    if (existing.choice === choice) {
      // 取消投票
      await supabase
        .from('post_votes')
        .delete()
        .eq('id', existing.id)
      return { action: 'removed', vote: null }
    } else {
      // 改变投票
      await supabase
        .from('post_votes')
        .update({ choice })
        .eq('id', existing.id)
      return { action: 'changed', vote: choice }
    }
  } else {
    // 新增投票
    await supabase
      .from('post_votes')
      .insert({
        post_id: postId,
        user_id: userId,
        choice,
      })
    return { action: 'added', vote: choice }
  }
}

/**
 * 批量获取用户对帖子的反应状态
 */
export async function getUserPostReactions(
  supabase: SupabaseClient,
  postIds: string[],
  userId: string
): Promise<Map<string, 'up' | 'down'>> {
  const { data, error } = await supabase
    .from('post_likes')
    .select('post_id, reaction_type')
    .in('post_id', postIds)
    .eq('user_id', userId)

  const map = new Map<string, 'up' | 'down'>()
  if (!error && data) {
    data.forEach((d: { post_id: string; reaction_type: string }) => {
      map.set(d.post_id, d.reaction_type as 'up' | 'down')
    })
  }
  return map
}

/**
 * 批量获取用户对帖子的投票状态
 */
export async function getUserPostVotes(
  supabase: SupabaseClient,
  postIds: string[],
  userId: string
): Promise<Map<string, 'bull' | 'bear' | 'wait'>> {
  const { data, error } = await supabase
    .from('post_votes')
    .select('post_id, choice')
    .in('post_id', postIds)
    .eq('user_id', userId)

  const map = new Map<string, 'bull' | 'bear' | 'wait'>()
  if (!error && data) {
    data.forEach((d: { post_id: string; choice: string }) => {
      map.set(d.post_id, d.choice as 'bull' | 'bear' | 'wait')
    })
  }
  return map
}

