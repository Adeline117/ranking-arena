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
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  original_post?: OriginalPost | null
  images?: string[] | null
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
  group_ids?: string[]
  author_handle?: string
  sort_by?: 'created_at' | 'hot_score' | 'like_count'
  sort_order?: 'asc' | 'desc'
}

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
  created_at: string
  updated_at?: string
  original_post_id?: string | null
  groups?: { name: string } | { name: string }[]
}

interface AuthorProfile {
  handle: string | null
  avatar_url: string | null
  is_pro: boolean
  show_pro_badge: boolean
}

/**
 * 构建作者资料映射
 */
function buildAuthorProfileMap(
  profiles: Array<{
    id: string
    handle: string | null
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
 * 提取 group name
 */
function extractGroupName(groups: PostRow['groups']): string | undefined {
  if (!groups) return undefined
  return Array.isArray(groups) ? groups[0]?.name : groups.name
}

/**
 * 转换数据库行为 PostWithAuthor 对象
 */
function toPostWithAuthor(
  row: PostRow,
  profile?: AuthorProfile,
  originalPost?: OriginalPost | null
): PostWithAuthor {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    author_id: row.author_id,
    author_handle: profile?.handle || row.author_handle,
    author_avatar_url: profile?.avatar_url ?? undefined,
    author_is_pro: profile?.is_pro ?? false,
    author_show_pro_badge: profile?.show_pro_badge !== false,
    group_id: row.group_id,
    group_name: extractGroupName(row.groups),
    poll_enabled: row.poll_enabled || false,
    poll_bull: row.poll_bull || 0,
    poll_bear: row.poll_bear || 0,
    poll_wait: row.poll_wait || 0,
    like_count: row.like_count || 0,
    dislike_count: row.dislike_count || 0,
    comment_count: row.comment_count || 0,
    bookmark_count: row.bookmark_count || 0,
    repost_count: row.repost_count || 0,
    view_count: row.view_count || 0,
    hot_score: row.hot_score || 0,
    is_pinned: row.is_pinned || false,
    images: row.images || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    original_post_id: row.original_post_id || null,
    original_post: originalPost ?? null,
  }
}

const POST_SELECT_FIELDS = `
  id, title, content, author_id, author_handle, group_id,
  poll_enabled, poll_id, poll_bull, poll_bear, poll_wait,
  like_count, dislike_count, comment_count, bookmark_count,
  repost_count, view_count, hot_score, is_pinned, images,
  created_at, updated_at, original_post_id, groups(name)
`

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
    group_ids,
    author_handle,
    sort_by = 'created_at',
    sort_order = 'desc',
  } = options

  let query = supabase
    .from('posts')
    .select(POST_SELECT_FIELDS)
    .range(offset, offset + limit - 1)
    .order(sort_by, { ascending: sort_order === 'asc' })

  if (group_id) {
    query = query.eq('group_id', group_id)
  } else if (group_ids && group_ids.length > 0) {
    query = query.in('group_id', group_ids)
  }

  if (author_handle) {
    const { data: authorProfile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', author_handle)
      .maybeSingle()

    query = authorProfile?.id
      ? query.eq('author_id', authorProfile.id)
      : query.eq('author_handle', author_handle)
  }

  const { data, error } = await query
  if (error) throw error
  if (!data || data.length === 0) return []

  const authorIds = [...new Set(data.map(p => p.author_id).filter(Boolean))]
  const originalPostIds = [...new Set(data.map(p => p.original_post_id).filter((id): id is string => !!id))]

  const [profilesResult, originalPostsResult] = await Promise.all([
    authorIds.length > 0
      ? supabase.from('user_profiles').select('id, handle, avatar_url, subscription_tier, show_pro_badge').in('id', authorIds)
      : Promise.resolve({ data: null }),
    originalPostIds.length > 0
      ? supabase.from('posts').select('id, title, content, author_id, author_handle, images, created_at').in('id', originalPostIds)
      : Promise.resolve({ data: null }),
  ])

  const authorProfileMap = profilesResult.data ? buildAuthorProfileMap(profilesResult.data) : new Map()

  const originalPostMap = new Map<string, OriginalPost>()
  if (originalPostsResult.data && originalPostsResult.data.length > 0) {
    const originalAuthorIds = [...new Set(originalPostsResult.data.map((p: { author_id: string }) => p.author_id).filter(Boolean))]
    const missingIds = originalAuthorIds.filter(id => !authorProfileMap.has(id))

    if (missingIds.length > 0) {
      const { data: originalProfiles } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
        .in('id', missingIds)

      if (originalProfiles) {
        for (const p of originalProfiles) {
          authorProfileMap.set(p.id, {
            handle: p.handle,
            avatar_url: p.avatar_url,
            is_pro: p.subscription_tier === 'pro',
            show_pro_badge: p.show_pro_badge !== false,
          })
        }
      }
    }

    for (const op of originalPostsResult.data) {
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
    }
  }

  return data.map((post: PostRow) =>
    toPostWithAuthor(
      post,
      authorProfileMap.get(post.author_id),
      post.original_post_id ? originalPostMap.get(post.original_post_id) : null
    )
  )
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
    .select(POST_SELECT_FIELDS)
    .eq('id', postId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const authorIds = [data.author_id].filter(Boolean)
  const originalPostId = data.original_post_id

  const [profileResult, originalPostResult] = await Promise.all([
    authorIds.length > 0
      ? supabase.from('user_profiles').select('id, handle, avatar_url, subscription_tier, show_pro_badge').in('id', authorIds)
      : Promise.resolve({ data: null }),
    originalPostId
      ? supabase.from('posts').select('id, title, content, author_id, author_handle, images, created_at').eq('id', originalPostId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const authorProfileMap = profileResult.data ? buildAuthorProfileMap(profileResult.data) : new Map()

  let originalPost: OriginalPost | null = null
  if (originalPostResult.data) {
    const op = originalPostResult.data
    let opProfile = authorProfileMap.get(op.author_id)

    if (!opProfile && op.author_id) {
      const { data: opProfileData } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
        .eq('id', op.author_id)
        .maybeSingle()

      if (opProfileData) {
        opProfile = {
          handle: opProfileData.handle,
          avatar_url: opProfileData.avatar_url,
          is_pro: opProfileData.subscription_tier === 'pro',
          show_pro_badge: opProfileData.show_pro_badge !== false,
        }
      }
    }

    originalPost = {
      id: op.id,
      title: op.title,
      content: op.content,
      author_handle: opProfile?.handle || op.author_handle,
      author_avatar_url: opProfile?.avatar_url || null,
      images: op.images || null,
      created_at: op.created_at,
    }
  }

  return toPostWithAuthor(data as PostRow, authorProfileMap.get(data.author_id), originalPost)
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

  if (error) throw error
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
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', postId)
    .eq('author_id', userId)
    .select()
    .single()

  if (error) throw error
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
    .eq('author_id', userId)

  if (error) throw error
}

/**
 * 增加浏览次数
 */
export async function incrementViewCount(
  supabase: SupabaseClient,
  postId: string
): Promise<void> {
  const { error } = await supabase.rpc('increment_post_view', { post_id: postId })
  if (error) {
    // RPC 不存在时的降级处理（view_count 在数据库层自增更安全）
    console.warn('increment_post_view RPC not available:', error.message)
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

