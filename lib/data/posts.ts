/**
 * 帖子数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/**
 * Simple language detection heuristic.
 * If content contains CJK characters, classify as 'zh'; otherwise 'en'.
 */
export function detectPostLanguage(content: string): string {
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/
  const cjkCount = (content.match(new RegExp(cjkRegex.source, 'g')) || []).length
  const ratio = cjkCount / Math.max(content.length, 1)
  if (ratio > 0.1) return 'zh'
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(content)) return 'ja'
  if (/[\uac00-\ud7af]/.test(content)) return 'ko'
  return 'en'
}

export type PostVisibility = 'public' | 'followers' | 'group'

export interface Post {
  id: string
  title: string
  content: string
  author_id: string
  author_handle: string
  group_id?: string
  group_name?: string
  group_name_en?: string
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
  visibility?: PostVisibility
  is_sensitive?: boolean
  content_warning?: string | null
  language?: string
}

export interface OriginalPost {
  id: string
  title: string | null
  content: string | null
  author_handle: string | null
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
  visibility?: PostVisibility
  is_sensitive?: boolean
  content_warning?: string
  language?: string
}

export interface PostListOptions {
  limit?: number
  offset?: number
  group_id?: string
  group_ids?: string[]
  author_handle?: string
  sort_by?: 'created_at' | 'hot_score' | 'like_count'
  sort_order?: 'asc' | 'desc'
  viewer_id?: string
  language?: string
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
  groups?: { name: string; name_en?: string | null } | { name: string; name_en?: string | null }[]
  visibility?: PostVisibility
  is_sensitive?: boolean
  content_warning?: string | null
  language?: string
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
 * 提取 group name_en
 */
function extractGroupNameEn(groups: PostRow['groups']): string | undefined {
  if (!groups) return undefined
  const g = Array.isArray(groups) ? groups[0] : groups
  return g?.name_en ?? undefined
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
    group_name_en: extractGroupNameEn(row.groups),
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
    visibility: (row.visibility as PostVisibility) || 'public',
    is_sensitive: row.is_sensitive || false,
    content_warning: row.content_warning || null,
    language: row.language || 'zh',
  }
}

const POST_SELECT_FIELDS = `
  id, title, content, author_id, author_handle, group_id,
  poll_enabled, poll_id, poll_bull, poll_bear, poll_wait,
  like_count, dislike_count, comment_count, bookmark_count,
  repost_count, view_count, hot_score, is_pinned, images,
  created_at, updated_at, original_post_id,
  visibility, is_sensitive, content_warning, language,
  groups(name, name_en)
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
    viewer_id,
    language: langFilter,
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

  // Visibility filtering: unauthenticated users only see public posts
  if (!group_id && !viewer_id) {
    query = query.eq('visibility', 'public')
  }

  // Language filter
  if (langFilter) {
    query = query.eq('language', langFilter)
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

  let filteredData = data as PostRow[]

  // Post-fetch visibility filtering for "followers" posts
  if (!group_id && viewer_id) {
    const followersPostAuthors = [...new Set(
      filteredData
        .filter(p => p.visibility === 'followers')
        .map(p => p.author_id)
    )]

    let followedSet = new Set<string>()
    if (followersPostAuthors.length > 0) {
      const { data: follows } = await supabase
        .from('user_follows')
        .select('following_id')
        .eq('follower_id', viewer_id)
        .in('following_id', followersPostAuthors)

      if (follows) {
        followedSet = new Set(follows.map((f: { following_id: string }) => f.following_id))
      }
    }

    filteredData = filteredData.filter(post => {
      if (post.visibility === 'public') return true
      if (post.visibility === 'followers') {
        return post.author_id === viewer_id || followedSet.has(post.author_id)
      }
      if (post.visibility === 'group') return false
      return true
    })
  }

  return filteredData.map((post: PostRow) =>
    toPostWithAuthor(
      post,
      authorProfileMap.get(post.author_id),
      post.original_post_id ? originalPostMap.get(post.original_post_id) : null
    )
  )
}

/**
 * Search posts using full-text search
 */
export async function searchPosts(
  supabase: SupabaseClient,
  query: string,
  options: { limit?: number; offset?: number; viewer_id?: string } = {}
): Promise<{ posts: PostWithAuthor[]; total: number }> {
  const { limit = 20, offset = 0, viewer_id } = options

  let queryBuilder = supabase
    .from('posts')
    .select(POST_SELECT_FIELDS, { count: 'exact' })
    .textSearch('search_vector', query, { type: 'plain' })
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false })

  if (!viewer_id) {
    queryBuilder = queryBuilder.eq('visibility', 'public')
  }

  const { data, error, count } = await queryBuilder
  if (error) throw error
  if (!data || data.length === 0) return { posts: [], total: 0 }

  const authorIds = [...new Set(data.map(p => p.author_id).filter(Boolean))]
  const { data: profiles } = authorIds.length > 0
    ? await supabase.from('user_profiles').select('id, handle, avatar_url, subscription_tier, show_pro_badge').in('id', authorIds)
    : { data: null }

  const profileMap = profiles ? buildAuthorProfileMap(profiles) : new Map()

  let filteredData = data as PostRow[]
  if (viewer_id) {
    const followersAuthors = [...new Set(
      filteredData.filter(p => p.visibility === 'followers').map(p => p.author_id)
    )]
    let followedSet = new Set<string>()
    if (followersAuthors.length > 0) {
      const { data: follows } = await supabase
        .from('user_follows')
        .select('following_id')
        .eq('follower_id', viewer_id)
        .in('following_id', followersAuthors)
      if (follows) {
        followedSet = new Set(follows.map((f: { following_id: string }) => f.following_id))
      }
    }
    filteredData = filteredData.filter(post => {
      if (post.visibility === 'public') return true
      if (post.visibility === 'followers') {
        return post.author_id === viewer_id || followedSet.has(post.author_id)
      }
      return post.visibility !== 'group'
    })
  }

  const posts = filteredData.map((post: PostRow) =>
    toPostWithAuthor(post, profileMap.get(post.author_id), null)
  )

  return { posts, total: count || posts.length }
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
  // Fetch author's reputation data for weighted feed
  let authorScore = 0
  let authorVerified = false
  try {
    const result = await supabase
      .from('user_profiles')
      .select('reputation_score, is_verified_trader')
      .eq('id', userId)
      .maybeSingle()
    authorScore = result?.data?.reputation_score ?? 0
    authorVerified = result?.data?.is_verified_trader ?? false
  } catch {
    // Intentionally swallowed: reputation score lookup failed, post will be created with default score 0
  }

  const detectedLanguage = input.language || detectPostLanguage((input.title ? input.title + ' ' : '') + input.content)

  const { data, error } = await supabase
    .from('posts')
    .insert({
      title: input.title,
      content: input.content,
      author_id: userId,
      author_handle: userHandle,
      group_id: input.group_id || null,
      poll_enabled: input.poll_enabled || false,
      author_arena_score: authorScore,
      author_is_verified: authorVerified,
      visibility: input.visibility || (input.group_id ? 'group' : 'public'),
      is_sensitive: input.is_sensitive || false,
      content_warning: input.content_warning || null,
      language: detectedLanguage,
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
  updates: { title?: string; content?: string; poll_enabled?: boolean; visibility?: PostVisibility; is_sensitive?: boolean; content_warning?: string | null }
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
    logger.warn('increment_post_view RPC not available:', error.message)
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
      // 取消点赞/踩 - use compound match to avoid deleting wrong row in race
      const { count } = await supabase
        .from('post_likes')
        .delete({ count: 'exact' })
        .eq('post_id', postId)
        .eq('user_id', userId)
        .eq('reaction_type', reactionType)
      if (count === 0) {
        // Row already changed by concurrent request, re-check
        return { action: 'removed', reaction: null }
      }
      return { action: 'removed', reaction: null }
    } else {
      // 切换点赞/踩
      await supabase
        .from('post_likes')
        .update({ reaction_type: reactionType })
        .eq('post_id', postId)
        .eq('user_id', userId)
      return { action: 'changed', reaction: reactionType }
    }
  } else {
    // 新增点赞/踩 - use upsert to handle race where two requests both see no existing row
    const { error } = await supabase
      .from('post_likes')
      .upsert(
        {
          post_id: postId,
          user_id: userId,
          reaction_type: reactionType,
        },
        { onConflict: 'post_id,user_id' }
      )
    if (error) {
      throw error
    }
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
      // 取消投票 - use compound match for race safety
      await supabase
        .from('post_votes')
        .delete()
        .eq('post_id', postId)
        .eq('user_id', userId)
      return { action: 'removed', vote: null }
    } else {
      // 改变投票
      await supabase
        .from('post_votes')
        .update({ choice })
        .eq('post_id', postId)
        .eq('user_id', userId)
      return { action: 'changed', vote: choice }
    }
  } else {
    // 新增投票 - use upsert to handle concurrent inserts
    const { error } = await supabase
      .from('post_votes')
      .upsert(
        {
          post_id: postId,
          user_id: userId,
          choice,
        },
        { onConflict: 'post_id,user_id' }
      )
    if (error) {
      throw error
    }
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

