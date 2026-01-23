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
  bookmark_count: number
  repost_count: number
  view_count: number
  hot_score: number
  is_pinned: boolean
  created_at: string
  updated_at?: string
  // 转发相关
  original_post_id?: string | null
}

export interface OriginalPost {
  id: string
  title: string
  content: string
  author_handle: string
  author_avatar_url?: string | null
  images?: string[] | null
  created_at: string
}

export interface PostWithAuthor extends Post {
  author_avatar_url?: string
  // 原始帖子信息（如果是转发）
  original_post?: OriginalPost | null
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

// 数据库返回的帖子行类型
interface PostRow {
  id: string
  title: string
  content: string
  author_id: string
  author_handle: string
  group_id?: string
  poll_enabled?: boolean
  poll_id?: string | null
  poll_bull?: number
  poll_bear?: number
  poll_wait?: number
  like_count?: number
  dislike_count?: number
  comment_count?: number
  bookmark_count?: number
  repost_count?: number
  view_count?: number
  hot_score?: number
  is_pinned?: boolean
  images?: string[]
  link_preview_url?: string
  link_preview_title?: string
  link_preview_description?: string
  link_preview_image?: string
  created_at: string
  updated_at?: string
  original_post_id?: string | null
  groups?: { name: string } | { name: string }[]
  original_posts?: {
    id: string
    title: string
    content: string
    author_handle: string
    images?: string[]
    created_at: string
    user_profiles?: { avatar_url?: string }
  }
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

  // 查询帖子列表，包含转发的原始帖子信息
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
      bookmark_count,
      repost_count,
      view_count,
      hot_score,
      is_pinned,
      images,
      created_at,
      updated_at,
      original_post_id,
      groups(name)
    `)
    .range(offset, offset + limit - 1)
    .order(sort_by, { ascending: sort_order === 'asc' })

  if (group_id) {
    query = query.eq('group_id', group_id)
  }

  if (author_handle) {
    // 先通过 handle 查找用户 ID，再用 author_id 过滤（避免改名后找不到旧帖子）
    const { data: authorProfile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', author_handle)
      .maybeSingle()

    if (authorProfile?.id) {
      query = query.eq('author_id', authorProfile.id)
    } else {
      // 如果找不到用户，降级为直接用 handle 查询
      query = query.eq('author_handle', author_handle)
    }
  }

  const { data, error } = await query

  if (error) {
    throw error
  }

  // 收集所有需要的作者 ID 和原始帖子 ID
  const authorIds = [...new Set((data || []).map(p => p.author_id).filter(Boolean))]
  const originalPostIds = [...new Set(
    (data || [])
      .map(p => p.original_post_id)
      .filter((id): id is string => !!id)
  )]

  // 并行获取作者资料（通过 author_id 获取最新 handle 和头像）和原始帖子数据
  const [profilesResult, originalPostsResult] = await Promise.all([
    authorIds.length > 0
      ? supabase.from('user_profiles').select('id, handle, avatar_url').in('id', authorIds)
      : Promise.resolve({ data: null }),
    originalPostIds.length > 0
      ? supabase.from('posts').select('id, title, content, author_id, author_handle, images, created_at').in('id', originalPostIds)
      : Promise.resolve({ data: null }),
  ])

  // 构建作者资料映射 (author_id → { handle, avatar_url })
  const authorProfileMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
  if (profilesResult.data) {
    profilesResult.data.forEach((p: { id: string; handle: string | null; avatar_url: string | null }) => {
      authorProfileMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
    })
  }

  // 处理原始帖子 + 获取原始帖子作者资料
  const originalPostMap = new Map<string, OriginalPost>()
  if (originalPostsResult.data && originalPostsResult.data.length > 0) {
    const originalAuthorIds = [...new Set(
      originalPostsResult.data.map((p: { author_id: string }) => p.author_id).filter(Boolean)
    )]

    // 仅查询作者资料映射中不存在的 IDs
    const missingIds = originalAuthorIds.filter(id => !authorProfileMap.has(id))
    if (missingIds.length > 0) {
      const { data: originalProfiles } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url')
        .in('id', missingIds)

      if (originalProfiles) {
        originalProfiles.forEach((p: { id: string; handle: string | null; avatar_url: string | null }) => {
          authorProfileMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
        })
      }
    }

    originalPostsResult.data.forEach((op: { id: string; title: string; content: string; author_id: string; author_handle: string; images?: string[]; created_at: string }) => {
      const opProfile = authorProfileMap.get(op.author_id)
      originalPostMap.set(op.id, {
        id: op.id,
        title: op.title,
        content: op.content,
        author_handle: opProfile?.handle || op.author_handle,
        author_avatar_url: opProfile?.avatar_url || null,
        images: op.images || null,
        created_at: op.created_at,
      })
    })
  }

  return (data || []).map((post: PostRow) => {
    const profile = authorProfileMap.get(post.author_id)
    return {
    id: post.id,
    title: post.title,
    content: post.content,
    author_id: post.author_id,
    author_handle: profile?.handle || post.author_handle,
    author_avatar_url: profile?.avatar_url || undefined,
    group_id: post.group_id,
    group_name: Array.isArray(post.groups) ? post.groups[0]?.name : post.groups?.name,
    poll_enabled: post.poll_enabled || false,
    poll_id: post.poll_id || null,
    poll_bull: post.poll_bull || 0,
    poll_bear: post.poll_bear || 0,
    poll_wait: post.poll_wait || 0,
    like_count: post.like_count || 0,
    dislike_count: post.dislike_count || 0,
    comment_count: post.comment_count || 0,
    bookmark_count: post.bookmark_count || 0,
    repost_count: post.repost_count || 0,
    view_count: post.view_count || 0,
    hot_score: post.hot_score || 0,
    is_pinned: post.is_pinned || false,
    images: post.images || null,
    created_at: post.created_at,
    updated_at: post.updated_at,
    original_post_id: post.original_post_id || null,
    original_post: post.original_post_id ? originalPostMap.get(post.original_post_id) || null : null,
  }})
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
      bookmark_count,
      repost_count,
      view_count,
      hot_score,
      is_pinned,
      created_at,
      updated_at,
      original_post_id,
      groups(name)
    `)
    .eq('id', postId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) return null

  // 获取作者当前 handle 和头像（通过 author_id 查找，避免改名后的旧 handle 问题）
  let author_avatar_url: string | undefined
  let current_author_handle: string = data.author_handle || ''
  if (data.author_id) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle, avatar_url')
      .eq('id', data.author_id)
      .maybeSingle()

    author_avatar_url = profile?.avatar_url || undefined
    current_author_handle = profile?.handle || data.author_handle || ''
  }

  // 获取原始帖子数据（如果是转发）
  let original_post: OriginalPost | null = null
  if (data.original_post_id) {
    const { data: originalPostData } = await supabase
      .from('posts')
      .select(`
        id,
        title,
        content,
        author_id,
        author_handle,
        images,
        created_at
      `)
      .eq('id', data.original_post_id)
      .maybeSingle()

    if (originalPostData) {
      // 获取原始帖子作者当前 handle 和头像（通过 author_id）
      let original_author_avatar_url: string | null = null
      let original_author_handle: string = originalPostData.author_handle || ''
      if (originalPostData.author_id) {
        const { data: originalProfile } = await supabase
          .from('user_profiles')
          .select('handle, avatar_url')
          .eq('id', originalPostData.author_id)
          .maybeSingle()

        original_author_avatar_url = originalProfile?.avatar_url || null
        original_author_handle = originalProfile?.handle || originalPostData.author_handle || ''
      }

      original_post = {
        id: originalPostData.id,
        title: originalPostData.title,
        content: originalPostData.content,
        author_handle: original_author_handle,
        author_avatar_url: original_author_avatar_url,
        images: originalPostData.images || null,
        created_at: originalPostData.created_at,
      }
    }
  }

  return {
    id: data.id,
    title: data.title,
    content: data.content,
    author_id: data.author_id,
    author_handle: current_author_handle,
    author_avatar_url,
    group_id: data.group_id,
    group_name: (() => { const g = (data as PostRow).groups; return Array.isArray(g) ? g[0]?.name : g?.name; })(),
    poll_enabled: data.poll_enabled || false,
    poll_bull: data.poll_bull || 0,
    poll_bear: data.poll_bear || 0,
    poll_wait: data.poll_wait || 0,
    like_count: data.like_count || 0,
    dislike_count: data.dislike_count || 0,
    comment_count: data.comment_count || 0,
    bookmark_count: data.bookmark_count || 0,
    repost_count: data.repost_count || 0,
    view_count: data.view_count || 0,
    hot_score: data.hot_score || 0,
    is_pinned: data.is_pinned || false,
    created_at: data.created_at,
    updated_at: data.updated_at,
    original_post_id: data.original_post_id || null,
    original_post,
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

