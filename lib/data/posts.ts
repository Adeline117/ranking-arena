/**
 * 帖子数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { delByPattern } from '@/lib/cache'
import { CachePattern } from '@/lib/cache/keys'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'
export {
  canServiceActorReadPost,
  filterServiceReadablePostRows,
} from '@/lib/data/service-post-audience'
// Dynamic import: sanitize.ts pulls in the sanitize-html parser, only needed
// for write operations — keep it out of read-path cold starts.
const loadSanitize = () => import('@/lib/utils/sanitize').then((m) => m.sanitizeText)

/** Best-effort invalidation of all post list caches */
async function invalidatePostListCache(): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax
  await delByPattern(CachePattern.allPosts()).catch(() => {})
}

// --- Hot ranking with recency decay (U8-8) -------------------------------
// The `hot_score` column is a frozen engagement number: once a post stops
// gathering reactions its score never changes, so ordering the "hot" feed by
// the raw column pins stale seed posts to the top forever. We instead pull a
// recency-ordered candidate pool and re-rank it in JS with a Reddit-style hot
// score: a log-scaled engagement term plus a linear time term. The time term
// dominates so fresh posts surface, while `hot_score` still breaks ties and
// lifts genuinely trending content. Additive (not multiplicative) form avoids
// float underflow-to-zero for old posts, keeping the order total & stable.
const HOT_POOL_SIZE = 300
// Authorize hot candidates progressively so the common first page does not
// fan out into 300 service-role audience checks. We keep walking the ranked
// pool until the requested page is full, preserving readable-row pagination.
const HOT_AUDIENCE_CHUNK_SIZE = 40
// Seconds of freshness worth one decade (10x) of engagement. One full unit of
// log10(hot_score) ≈ 1 day of recency, so a hot_score-10 post ranks like a
// day-newer hot_score-1 post.
const HOT_DECAY_SECONDS = 86_400
// Fixed reference epoch so the time term stays a small, well-conditioned float
// (ordering is translation-invariant, so the exact value is irrelevant).
const HOT_EPOCH_SECONDS = Date.UTC(2026, 0, 1) / 1000

function hotRankScore(hotScore: number | null | undefined, createdAt: string | null): number {
  const engagement = Math.log10(Math.max(hotScore ?? 0, 1)) // 0 for score<=1
  const createdMs = createdAt ? Date.parse(createdAt) : NaN
  const seconds = Number.isNaN(createdMs) ? 0 : createdMs / 1000 - HOT_EPOCH_SECONDS
  return engagement + seconds / HOT_DECAY_SECONDS
}

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
  content_version?: number
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

export interface PostListOptions {
  limit?: number
  offset?: number
  group_id?: string
  group_ids?: string[]
  author_handle?: string
  /** Filter posts by specific author IDs (for following feed) */
  author_ids?: string[]
  /** Filter to specific post IDs (for personalized feed — posts.author_id has no FK, so PostgREST embeds are unsupported; this reuses the two-step author merge) */
  post_ids?: string[]
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
  content_version?: number
  original_post_id?: string | null
  groups?: { name: string; name_en?: string | null } | { name: string; name_en?: string | null }[]
  visibility?: PostVisibility
  is_sensitive?: boolean
  content_warning?: string | null
  language?: string
  status?: string | null
  deleted_at?: string | null
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
    content_version: row.content_version,
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
  created_at, updated_at, content_version, original_post_id,
  visibility, is_sensitive, content_warning, language,
  status, deleted_at,
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
    author_ids,
    post_ids,
    sort_by = 'created_at',
    sort_order = 'desc',
    viewer_id,
    language: langFilter,
  } = options

  // An explicit empty scope is empty, never "no filter". Skipping `.in()` for
  // [] would otherwise widen a following/personalized/group query to all rows.
  if (group_ids && group_ids.length === 0) return []
  if (author_ids && author_ids.length === 0) return []
  if (post_ids && post_ids.length === 0) return []

  // Hot feed gets a recency-ordered candidate pool + JS decay re-rank (see
  // hotRankScore). Other sorts keep the direct column order + DB pagination.
  const isHotSort = sort_by === 'hot_score'
  let query = supabase.from('posts').select(POST_SELECT_FIELDS)
  if (isHotSort) {
    query = query.order('created_at', { ascending: false }).range(0, HOT_POOL_SIZE - 1)
  } else {
    query = query
      .range(offset, offset + limit - 1)
      .order(sort_by, { ascending: sort_order === 'asc' })
  }

  // This function is called with a service-role client and therefore bypasses
  // posts RLS. Deleted rows must be excluded explicitly for every list shape.
  query = query.neq('status', 'deleted').is('deleted_at', null)

  if (group_id) {
    query = query.eq('group_id', group_id)
  } else if (group_ids && group_ids.length > 0) {
    query = query.in('group_id', group_ids)
  }

  // Following feed: filter to specific author IDs
  if (author_ids && author_ids.length > 0) {
    query = query.in('author_id', author_ids)
  }

  // Personalized feed: filter to specific post IDs
  if (post_ids && post_ids.length > 0) {
    query = query.in('id', post_ids)
  }

  // Visibility filtering: unauthenticated users only see public posts
  if (!group_id && !viewer_id) {
    query = query.eq('visibility', 'public')
    // Until group containers are checked by the canonical audience RPC, a
    // stale public row inside a closed group must not enter general anon feeds.
    if (!group_ids) query = query.is('group_id', null)
  }

  // Block filtering: exclude posts from users the viewer has blocked (and vice versa)
  if (viewer_id) {
    const { data: blocks, error: blocksError } = await supabase
      .from('blocked_users')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${viewer_id},blocked_id.eq.${viewer_id}`)
    if (blocksError) throw blocksError
    if (blocks && blocks.length > 0) {
      const blockedIds = new Set<string>()
      for (const b of blocks) {
        if (b.blocker_id === viewer_id) blockedIds.add(b.blocked_id)
        else blockedIds.add(b.blocker_id)
      }
      if (blockedIds.size > 0) {
        // PostgREST: not.in filter excludes posts from blocked users
        query = query.not('author_id', 'in', `(${[...blockedIds].join(',')})`)
      }
    }
  }

  // Language filter
  if (langFilter) {
    query = query.eq('language', langFilter)
  }

  if (author_handle) {
    const { data: authorProfile, error: authorProfileError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', author_handle)
      .maybeSingle()
    if (authorProfileError)
      logger.warn(
        '[getPosts] user_profiles handle lookup error (drift?):',
        authorProfileError.message
      )

    query = authorProfile?.id
      ? query.eq('author_id', authorProfile.id)
      : query.eq('author_handle', author_handle)
  }

  const { data: rawData, error } = await query
  if (error) throw error
  if (!rawData || rawData.length === 0) return []

  let data: PostRow[]
  if (isHotSort) {
    // Hot feed: re-rank the candidate pool, then authorize it in small chunks.
    // Pool is fetched from offset 0, so readable-row pagination stays stable
    // up to HOT_POOL_SIZE without issuing 300 RPCs for the usual first page.
    const ranked = [...(rawData as PostRow[])].sort(
      (a, b) => hotRankScore(b.hot_score, b.created_at) - hotRankScore(a.hot_score, a.created_at)
    )
    if (sort_order === 'asc') ranked.reverse()

    const readableRanked: PostRow[] = []
    for (
      let index = 0;
      index < ranked.length && readableRanked.length < offset + limit;
      index += HOT_AUDIENCE_CHUNK_SIZE
    ) {
      const chunk = ranked.slice(index, index + HOT_AUDIENCE_CHUNK_SIZE)
      readableRanked.push(...(await filterServiceReadablePostRows(supabase, chunk, viewer_id)))
    }
    data = readableRanked.slice(offset, offset + limit)
  } else {
    data = await filterServiceReadablePostRows(supabase, rawData as PostRow[], viewer_id)
  }
  if (data.length === 0) return []

  const authorIds = [...new Set(data.map((p) => p.author_id).filter(Boolean))]
  const originalPostIds = [
    ...new Set(data.map((p) => p.original_post_id).filter((id): id is string => !!id)),
  ]

  // Fetch original posts first to discover their author_ids, then batch ALL
  // author profiles in a single query (eliminates the 3rd sequential query
  // that previously fetched missing original-post author profiles).
  const originalPostsResult =
    originalPostIds.length > 0
      ? await supabase
          .from('posts')
          .select(
            'id, title, content, author_id, author_handle, images, created_at, group_id, visibility, status, deleted_at'
          )
          .in('id', originalPostIds)
          .neq('status', 'deleted')
          .is('deleted_at', null)
          .eq('visibility', 'public')
          .is('group_id', null)
      : { data: null, error: null }

  if (originalPostsResult.error) throw originalPostsResult.error
  const readableOriginalPosts = originalPostsResult.data
    ? await filterServiceReadablePostRows(supabase, originalPostsResult.data, viewer_id)
    : []

  // Combine post author IDs + original post author IDs into one batch
  const originalAuthorIds = readableOriginalPosts
    .map((p: { author_id: string }) => p.author_id)
    .filter(Boolean)
  const allAuthorIds = [...new Set([...authorIds, ...originalAuthorIds])]

  const profilesResult =
    allAuthorIds.length > 0
      ? await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
          .in('id', allAuthorIds)
      : { data: null }

  const authorProfileMap = profilesResult.data
    ? buildAuthorProfileMap(profilesResult.data)
    : new Map()

  const originalPostMap = new Map<string, OriginalPost>()
  if (readableOriginalPosts.length > 0) {
    for (const op of readableOriginalPosts) {
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
  if (!group_id && !group_ids && viewer_id) {
    const followersPostAuthors = [
      ...new Set(filteredData.filter((p) => p.visibility === 'followers').map((p) => p.author_id)),
    ]

    let followedSet = new Set<string>()
    if (followersPostAuthors.length > 0) {
      const { data: follows, error: followsError } = await supabase
        .from('user_follows')
        .select('following_id')
        .eq('follower_id', viewer_id)
        .in('following_id', followersPostAuthors)
      if (followsError) throw followsError

      if (follows) {
        followedSet = new Set(follows.map((f: { following_id: string }) => f.following_id))
      }
    }

    filteredData = filteredData.filter((post) => {
      if (post.visibility === 'public') return true
      if (post.visibility === 'followers') {
        return post.author_id === viewer_id || followedSet.has(post.author_id)
      }
      if (post.visibility === 'group') return false
      return false
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
 * 获取单个帖子
 */
export async function getPostById(
  supabase: SupabaseClient,
  postId: string,
  viewerId?: string | null
): Promise<PostWithAuthor | null> {
  const { data, error } = await supabase
    .from('posts')
    .select(POST_SELECT_FIELDS)
    .eq('id', postId)
    .neq('status', 'deleted')
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const [readablePost] = await filterServiceReadablePostRows(supabase, [data as PostRow], viewerId)
  if (!readablePost) return null

  const authorIds = [readablePost.author_id].filter(Boolean)
  const originalPostId = readablePost.original_post_id

  const [profileResult, originalPostResult] = await Promise.all([
    authorIds.length > 0
      ? supabase
          .from('user_profiles')
          .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
          .in('id', authorIds)
      : Promise.resolve({ data: null }),
    originalPostId
      ? supabase
          .from('posts')
          .select(
            'id, title, content, author_id, author_handle, images, created_at, group_id, visibility, status, deleted_at'
          )
          .eq('id', originalPostId)
          .neq('status', 'deleted')
          .is('deleted_at', null)
          .eq('visibility', 'public')
          .is('group_id', null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (originalPostResult.error) throw originalPostResult.error
  const [readableOriginalPost] = originalPostResult.data
    ? await filterServiceReadablePostRows(supabase, [originalPostResult.data], viewerId)
    : []

  const authorProfileMap = profileResult.data
    ? buildAuthorProfileMap(profileResult.data)
    : new Map()

  let originalPost: OriginalPost | null = null
  if (readableOriginalPost) {
    const op = readableOriginalPost
    let opProfile = authorProfileMap.get(op.author_id)

    if (!opProfile && op.author_id) {
      const { data: opProfileData, error: opProfileError } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
        .eq('id', op.author_id)
        .maybeSingle()
      if (opProfileError)
        logger.warn(
          '[getPostById] user_profiles op-author query error (drift?):',
          opProfileError.message
        )

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

  return toPostWithAuthor(readablePost, authorProfileMap.get(readablePost.author_id), originalPost)
}

/**
 * 更新帖子
 */
export async function updatePost(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  updates: {
    title?: string
    content?: string
    poll_enabled?: boolean
    visibility?: PostVisibility
    is_sensitive?: boolean
    content_warning?: string | null
  }
): Promise<Post> {
  const sanitizedUpdates = { ...updates, updated_at: new Date().toISOString() }
  const sanitize = await loadSanitize()
  if (sanitizedUpdates.title) sanitizedUpdates.title = sanitize(sanitizedUpdates.title)
  if (sanitizedUpdates.content) sanitizedUpdates.content = sanitize(sanitizedUpdates.content)
  const { data, error } = await supabase
    .from('posts')
    .update(sanitizedUpdates)
    .eq('id', postId)
    .eq('author_id', userId)
    .select()
    .single()

  if (error) throw error

  // M-6: Invalidate post list caches after update
  await invalidatePostListCache()

  return data
}

/**
 * 删除帖子
 *
 * Returns whether a row was actually deleted. A bare `.delete().eq(...)` that
 * matches 0 rows (post missing, or caller is not the author) succeeds silently
 * — that silent no-op let QA canary posts leak into production because the
 * API kept answering 200 "Delete successful". `.select('id')` surfaces the
 * affected rows so callers can distinguish "deleted" from "nothing matched".
 */
export async function deletePost(
  supabase: SupabaseClient,
  postId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('posts')
    .delete()
    .eq('id', postId)
    .eq('author_id', userId)
    .select('id')

  if (error) throw error
  if (
    !Array.isArray(data) ||
    data.length !== 1 ||
    typeof data[0] !== 'object' ||
    data[0] === null ||
    !('id' in data[0]) ||
    data[0].id !== postId
  ) {
    return false
  }

  // M-6: Invalidate post list caches after deletion
  await invalidatePostListCache()
  return true
}

// incrementViewCount was removed: it had no production callers and the
// increment_post_view RPC it depended on never existed in prod (no repo
// migration defines it). If post-view counting is reintroduced, add an
// atomic RPC migration first (see CLAUDE.md counter rules).

export class PostInteractionReadError extends Error {
  constructor() {
    super('Post interaction read returned invalid data')
    this.name = 'PostInteractionReadError'
  }
}

function isExactInteractionRow(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actualKeys = Object.keys(value).sort()
  const keys = [...expectedKeys].sort()
  return actualKeys.length === keys.length && actualKeys.every((key, index) => key === keys[index])
}

function readInteractionValue<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[]
): T {
  if (!isExactInteractionRow(value, [key]) || !allowed.includes(value[key] as T)) {
    throw new PostInteractionReadError()
  }
  return value[key] as T
}

function readInteractionMap<T extends string>(
  value: unknown,
  requestedPostIds: ReadonlySet<string>,
  key: string,
  allowed: readonly T[]
): Map<string, T> {
  if (!Array.isArray(value)) throw new PostInteractionReadError()
  const result = new Map<string, T>()
  for (const row of value) {
    if (
      !isExactInteractionRow(row, ['post_id', key]) ||
      typeof row.post_id !== 'string' ||
      !requestedPostIds.has(row.post_id) ||
      result.has(row.post_id) ||
      !allowed.includes(row[key] as T)
    ) {
      throw new PostInteractionReadError()
    }
    result.set(row.post_id, row[key] as T)
  }
  return result
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

  if (error) throw error
  if (data === null) return null
  return readInteractionValue(data, 'reaction_type', ['up', 'down'] as const)
}

/**
 * 点赞/踩帖子 — atomic via PostgreSQL RPC to prevent TOCTOU race condition.
 * The RPC uses SELECT FOR UPDATE to serialize concurrent toggles for the same
 * (post_id, user_id) pair and maintains like_count/dislike_count atomically.
 */
export class PostInteractionMutationError extends Error {
  constructor(public readonly kind: 'not_found' | 'invalid' | 'invalid_ack') {
    super(
      kind === 'not_found'
        ? 'Post is not currently interactable'
        : kind === 'invalid'
          ? 'Invalid post interaction'
          : 'Post interaction RPC returned an invalid acknowledgement'
    )
    this.name = 'PostInteractionMutationError'
  }
}

export async function togglePostReaction(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  reactionType: 'up' | 'down'
): Promise<{
  action: 'added' | 'removed' | 'changed'
  reaction: 'up' | 'down' | null
  like_count: number
  dislike_count: number
}> {
  const { data, error } = await supabase.rpc('toggle_post_reaction', {
    p_post_id: postId,
    p_user_id: userId,
    p_reaction_type: reactionType,
  })

  if (error) throw error

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PostInteractionMutationError('invalid_ack')
  }
  const result = data as Record<string, unknown>
  if (result.status === 'not_found') throw new PostInteractionMutationError('not_found')
  if (result.status === 'invalid') throw new PostInteractionMutationError('invalid')
  const action = result.action
  const reaction = result.reaction
  const resultKeys = Object.keys(result).sort()
  const expectedResultKeys = ['action', 'dislike_count', 'like_count', 'reaction', 'status'].sort()
  const validAction = action === 'added' || action === 'removed' || action === 'changed'
  const validReaction =
    (action === 'removed' && reaction === null) ||
    ((action === 'added' || action === 'changed') && reaction === reactionType)
  if (
    resultKeys.length !== expectedResultKeys.length ||
    !resultKeys.every((key, index) => key === expectedResultKeys[index]) ||
    result.status !== action ||
    !validAction ||
    !validReaction ||
    !Number.isSafeInteger(result.like_count) ||
    (result.like_count as number) < 0 ||
    !Number.isSafeInteger(result.dislike_count) ||
    (result.dislike_count as number) < 0
  ) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  return {
    action,
    reaction: reaction as 'up' | 'down' | null,
    like_count: result.like_count as number,
    dislike_count: result.dislike_count as number,
  }
}

/**
 * Converge one actor's reaction to an absolute desired state. Unlike the
 * legacy toggle RPC, replaying this command after a lost response can never
 * reverse a successfully committed reaction.
 */
export async function setPostReactionDesiredState(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  desiredReaction: 'up' | 'down' | null
): Promise<{
  action: 'added' | 'removed' | 'changed' | 'unchanged'
  reaction: 'up' | 'down' | null
  like_count: number
  dislike_count: number
}> {
  const { data, error } = await supabase.rpc('set_post_reaction_desired_state_atomic', {
    p_actor_id: userId,
    p_post_id: postId,
    p_desired_reaction: desiredReaction,
  })

  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  const result = data as Record<string, unknown>
  const resultKeys = Object.keys(result).sort()
  if (
    resultKeys.length === 1 &&
    resultKeys[0] === 'status' &&
    (result.status === 'not_found' || result.status === 'invalid')
  ) {
    throw new PostInteractionMutationError(result.status)
  }

  const expectedResultKeys = ['action', 'dislike_count', 'like_count', 'reaction', 'status'].sort()
  const action = result.action
  const reaction = result.reaction
  const validAction =
    action === 'added' || action === 'removed' || action === 'changed' || action === 'unchanged'
  const actionMatchesDesired =
    (action === 'removed' && desiredReaction === null) ||
    ((action === 'added' || action === 'changed') && desiredReaction !== null) ||
    action === 'unchanged'

  if (
    resultKeys.length !== expectedResultKeys.length ||
    !resultKeys.every((key, index) => key === expectedResultKeys[index]) ||
    result.status !== action ||
    !validAction ||
    !actionMatchesDesired ||
    reaction !== desiredReaction ||
    !Number.isSafeInteger(result.like_count) ||
    (result.like_count as number) < 0 ||
    !Number.isSafeInteger(result.dislike_count) ||
    (result.dislike_count as number) < 0 ||
    (reaction === 'up' && (result.like_count as number) < 1) ||
    (reaction === 'down' && (result.dislike_count as number) < 1)
  ) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  return {
    action,
    reaction: reaction as 'up' | 'down' | null,
    like_count: result.like_count as number,
    dislike_count: result.dislike_count as number,
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

  if (error) throw error
  if (data === null) return null
  return readInteractionValue(data, 'choice', ['bull', 'bear', 'wait'] as const)
}

/**
 * 投票
 */
export async function togglePostVote(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  choice: 'bull' | 'bear' | 'wait'
): Promise<{
  action: 'added' | 'removed' | 'changed'
  vote: 'bull' | 'bear' | 'wait' | null
  poll: { bull: number; bear: number; wait: number }
}> {
  const { data, error } = await supabase.rpc('toggle_post_vote_atomic', {
    p_actor_id: userId,
    p_post_id: postId,
    p_choice: choice,
  })

  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  const result = data as Record<string, unknown>
  if (result.status === 'not_found') throw new PostInteractionMutationError('not_found')
  if (result.status === 'invalid') throw new PostInteractionMutationError('invalid')
  const action = result.action
  const vote = result.vote
  const poll = result.poll
  const validAction = action === 'added' || action === 'removed' || action === 'changed'
  const validVote =
    (action === 'removed' && vote === null) ||
    ((action === 'added' || action === 'changed') && vote === choice)
  if (
    result.status !== action ||
    !validAction ||
    !validVote ||
    !poll ||
    typeof poll !== 'object' ||
    Array.isArray(poll)
  ) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  const counts = poll as Record<string, unknown>
  if (
    !Number.isSafeInteger(counts.bull) ||
    (counts.bull as number) < 0 ||
    !Number.isSafeInteger(counts.bear) ||
    (counts.bear as number) < 0 ||
    !Number.isSafeInteger(counts.wait) ||
    (counts.wait as number) < 0
  ) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  return {
    action,
    vote: vote as 'bull' | 'bear' | 'wait' | null,
    poll: {
      bull: counts.bull as number,
      bear: counts.bear as number,
      wait: counts.wait as number,
    },
  }
}

/**
 * Converge one actor's built-in sentiment vote to an absolute desired state.
 * Replaying the same state after a lost response is safe and cannot remove or
 * reverse a vote that already committed.
 */
export async function setPostVoteDesiredState(
  supabase: SupabaseClient,
  postId: string,
  userId: string,
  desiredChoice: 'bull' | 'bear' | 'wait' | null
): Promise<{
  action: 'added' | 'removed' | 'changed' | 'unchanged'
  vote: 'bull' | 'bear' | 'wait' | null
  poll: { bull: number; bear: number; wait: number }
}> {
  const { data, error } = await supabase.rpc('set_post_vote_desired_state_atomic', {
    p_actor_id: userId,
    p_post_id: postId,
    p_desired_choice: desiredChoice,
  })

  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  const result = data as Record<string, unknown>
  const resultKeys = Object.keys(result).sort()
  if (
    resultKeys.length === 1 &&
    resultKeys[0] === 'status' &&
    (result.status === 'not_found' || result.status === 'invalid')
  ) {
    throw new PostInteractionMutationError(result.status)
  }

  const expectedResultKeys = ['action', 'poll', 'status', 'vote'].sort()
  const action = result.action
  const vote = result.vote
  const validAction =
    action === 'added' || action === 'removed' || action === 'changed' || action === 'unchanged'
  const actionMatchesDesired =
    (action === 'removed' && desiredChoice === null) ||
    ((action === 'added' || action === 'changed') && desiredChoice !== null) ||
    action === 'unchanged'
  const poll = result.poll

  if (
    resultKeys.length !== expectedResultKeys.length ||
    !resultKeys.every((key, index) => key === expectedResultKeys[index]) ||
    result.status !== action ||
    !validAction ||
    !actionMatchesDesired ||
    vote !== desiredChoice ||
    !poll ||
    typeof poll !== 'object' ||
    Array.isArray(poll)
  ) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  const counts = poll as Record<string, unknown>
  const countKeys = Object.keys(counts).sort()
  const expectedCountKeys = ['bear', 'bull', 'wait'].sort()
  if (
    countKeys.length !== expectedCountKeys.length ||
    !countKeys.every((key, index) => key === expectedCountKeys[index]) ||
    !Number.isSafeInteger(counts.bull) ||
    (counts.bull as number) < 0 ||
    !Number.isSafeInteger(counts.bear) ||
    (counts.bear as number) < 0 ||
    !Number.isSafeInteger(counts.wait) ||
    (counts.wait as number) < 0 ||
    (vote !== null && (counts[vote as 'bull' | 'bear' | 'wait'] as number) < 1)
  ) {
    throw new PostInteractionMutationError('invalid_ack')
  }

  return {
    action,
    vote: vote as 'bull' | 'bear' | 'wait' | null,
    poll: {
      bull: counts.bull as number,
      bear: counts.bear as number,
      wait: counts.wait as number,
    },
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
  const requestedPostIds = new Set(postIds)
  if (requestedPostIds.size === 0) return new Map()
  const { data, error } = await supabase
    .from('post_likes')
    .select('post_id, reaction_type')
    .in('post_id', [...requestedPostIds])
    .eq('user_id', userId)

  if (error) throw error
  return readInteractionMap(data, requestedPostIds, 'reaction_type', ['up', 'down'] as const)
}

/**
 * 批量获取用户对帖子的投票状态
 */
export async function getUserPostVotes(
  supabase: SupabaseClient,
  postIds: string[],
  userId: string
): Promise<Map<string, 'bull' | 'bear' | 'wait'>> {
  const requestedPostIds = new Set(postIds)
  if (requestedPostIds.size === 0) return new Map()
  const { data, error } = await supabase
    .from('post_votes')
    .select('post_id, choice')
    .in('post_id', [...requestedPostIds])
    .eq('user_id', userId)

  if (error) throw error
  return readInteractionMap(data, requestedPostIds, 'choice', ['bull', 'bear', 'wait'] as const)
}
