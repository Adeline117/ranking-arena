/**
 * Hashtag data layer
 * - Extract hashtags from post content
 * - Upsert into hashtags table
 * - Link via post_hashtags join table
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// Unicode-aware: \w 是 ASCII-only,会把 #比特币 这类 CJK 标签静默丢掉
// (2026-07-03 修复,与 lib/utils/content.ts 的 linkify regex 保持同步)。
const HASHTAG_REGEX = /#([\p{L}\p{N}_]{1,30})(?![\p{L}\p{N}_])/gu
// PostgreSQL's uuid type accepts the full 128-bit value space. Do not impose
// RFC version/variant bits here: repository-owned identities such as Arena Bot
// deliberately use stable UUID values outside the generated-v4 subset.
const POSTGRES_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TrendingHashtag {
  id: string
  tag: string
  post_count: number
}

export type HashtagPostSort = 'hot_score' | 'created_at'

export interface HashtagPostRow {
  id: string
  title: string
  content: string
  author_id: string
  author_handle: string | null
  author_avatar_url: string | null
  author_is_verified: boolean | null
  group_id: string | null
  poll_enabled: boolean | null
  poll_id: string | null
  poll_bull: number | null
  poll_bear: number | null
  poll_wait: number | null
  like_count: number | null
  dislike_count: number | null
  comment_count: number | null
  bookmark_count: number | null
  repost_count: number | null
  view_count: number | null
  hot_score: number | null
  is_pinned: boolean | null
  images: string[] | null
  created_at: string
  updated_at: string
  original_post_id: string | null
  visibility: string
  is_sensitive: boolean | null
  content_warning: string | null
  language: string | null
  user_reaction: 'up' | 'down' | null
  user_vote: 'bull' | 'bear' | 'wait' | null
  author: {
    id: string
    handle: string | null
    avatar_url: string | null
  }
}

type HashtagRpcPostRow = Omit<HashtagPostRow, 'author'>

export interface HashtagPostsPage {
  posts: HashtagPostRow[]
  tag: string
  total: number
  has_more: boolean
  next_cursor: null
}

export class HashtagViewerRejectedError extends Error {
  constructor() {
    super('Hashtag viewer is no longer active')
    this.name = 'HashtagViewerRejectedError'
  }
}

const HASHTAG_POST_KEYS = [
  'id',
  'title',
  'content',
  'author_id',
  'author_handle',
  'author_avatar_url',
  'author_is_verified',
  'group_id',
  'poll_enabled',
  'poll_id',
  'poll_bull',
  'poll_bear',
  'poll_wait',
  'like_count',
  'dislike_count',
  'comment_count',
  'bookmark_count',
  'repost_count',
  'view_count',
  'hot_score',
  'is_pinned',
  'images',
  'created_at',
  'updated_at',
  'original_post_id',
  'visibility',
  'is_sensitive',
  'content_warning',
  'language',
  'user_reaction',
  'user_vote',
] as const

const NULLABLE_TEXT_POST_FIELDS = [
  'author_handle',
  'author_avatar_url',
  'group_id',
  'poll_id',
  'original_post_id',
  'content_warning',
  'language',
] as const

const NULLABLE_BOOLEAN_POST_FIELDS = [
  'author_is_verified',
  'poll_enabled',
  'is_pinned',
  'is_sensitive',
] as const

const NULLABLE_COUNT_POST_FIELDS = [
  'poll_bull',
  'poll_bear',
  'poll_wait',
  'like_count',
  'dislike_count',
  'comment_count',
  'bookmark_count',
  'repost_count',
  'view_count',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isSafeNonnegativeInteger(value)
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}

function hashtagPostPrecedes(
  left: HashtagRpcPostRow,
  right: HashtagRpcPostRow,
  sortBy: HashtagPostSort
): boolean {
  if (sortBy === 'hot_score' && left.hot_score !== right.hot_score) {
    if (left.hot_score === null) return false
    if (right.hot_score === null) return true
    return left.hot_score > right.hot_score
  }
  const leftCreatedAt = Date.parse(left.created_at)
  const rightCreatedAt = Date.parse(right.created_at)
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt > rightCreatedAt
  return left.id > right.id
}

export function canonicalizeHashtag(tag: string): string {
  const normalized = tag.trim().toLowerCase()
  if (!normalized || Array.from(normalized).length > 30 || !/^[\p{L}\p{N}_]+$/u.test(normalized)) {
    throw new TypeError('Invalid hashtag')
  }
  return normalized
}

function decodeHashtagPost(value: unknown): HashtagRpcPostRow | null {
  if (!isRecord(value) || !hasExactKeys(value, HASHTAG_POST_KEYS)) return null
  if (
    typeof value.id !== 'string' ||
    !POSTGRES_UUID_RE.test(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.author_id !== 'string' ||
    !POSTGRES_UUID_RE.test(value.author_id) ||
    typeof value.created_at !== 'string' ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    typeof value.visibility !== 'string' ||
    !['public', 'followers', 'group'].includes(value.visibility) ||
    !NULLABLE_TEXT_POST_FIELDS.every((field) => isNullableString(value[field])) ||
    !NULLABLE_BOOLEAN_POST_FIELDS.every((field) => isNullableBoolean(value[field])) ||
    !NULLABLE_COUNT_POST_FIELDS.every((field) => isNullableCount(value[field])) ||
    !(
      value.user_reaction === null ||
      value.user_reaction === 'up' ||
      value.user_reaction === 'down'
    ) ||
    !(
      value.user_vote === null ||
      value.user_vote === 'bull' ||
      value.user_vote === 'bear' ||
      value.user_vote === 'wait'
    ) ||
    !(
      value.hot_score === null ||
      (typeof value.hot_score === 'number' && Number.isFinite(value.hot_score))
    ) ||
    !(
      value.images === null ||
      (Array.isArray(value.images) && value.images.every((image) => typeof image === 'string'))
    ) ||
    (value.group_id !== null && !POSTGRES_UUID_RE.test(value.group_id as string)) ||
    (value.poll_id !== null && !POSTGRES_UUID_RE.test(value.poll_id as string)) ||
    (value.original_post_id !== null && !POSTGRES_UUID_RE.test(value.original_post_id as string))
  ) {
    return null
  }

  return {
    id: value.id,
    title: value.title,
    content: value.content,
    author_id: value.author_id,
    author_handle: value.author_handle as string | null,
    author_avatar_url: value.author_avatar_url as string | null,
    author_is_verified: value.author_is_verified as boolean | null,
    group_id: value.group_id as string | null,
    poll_enabled: value.poll_enabled as boolean | null,
    poll_id: value.poll_id as string | null,
    poll_bull: value.poll_bull as number | null,
    poll_bear: value.poll_bear as number | null,
    poll_wait: value.poll_wait as number | null,
    like_count: value.like_count as number | null,
    dislike_count: value.dislike_count as number | null,
    comment_count: value.comment_count as number | null,
    bookmark_count: value.bookmark_count as number | null,
    repost_count: value.repost_count as number | null,
    view_count: value.view_count as number | null,
    hot_score: value.hot_score as number | null,
    is_pinned: value.is_pinned as boolean | null,
    images: value.images as string[] | null,
    created_at: value.created_at,
    updated_at: value.updated_at,
    original_post_id: value.original_post_id as string | null,
    visibility: value.visibility,
    is_sensitive: value.is_sensitive as boolean | null,
    content_warning: value.content_warning as string | null,
    language: value.language as string | null,
    user_reaction: value.user_reaction as 'up' | 'down' | null,
    user_vote: value.user_vote as 'bull' | 'bear' | 'wait' | null,
  }
}

function decodeTrendingHashtags(value: unknown, expectedLimit: number): TrendingHashtag[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['contract', 'viewer_id', 'limit', 'hashtags']) ||
    value.contract !== 'hashtag_trending_v1' ||
    value.viewer_id !== null ||
    value.limit !== expectedLimit ||
    !Array.isArray(value.hashtags)
  ) {
    throw new Error('Invalid trending hashtag acknowledgement')
  }

  const seenIds = new Set<string>()
  const seenTags = new Set<string>()
  const hashtags = value.hashtags.map((candidate) => {
    let canonicalTag: string | null = null
    if (isRecord(candidate) && typeof candidate.tag === 'string') {
      try {
        canonicalTag = canonicalizeHashtag(candidate.tag)
      } catch {
        canonicalTag = null
      }
    }
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['id', 'tag', 'post_count']) ||
      typeof candidate.id !== 'string' ||
      !POSTGRES_UUID_RE.test(candidate.id) ||
      typeof candidate.tag !== 'string' ||
      candidate.tag !== canonicalTag ||
      !isSafeNonnegativeInteger(candidate.post_count) ||
      candidate.post_count === 0 ||
      seenIds.has(candidate.id) ||
      seenTags.has(candidate.tag)
    ) {
      throw new Error('Invalid trending hashtag row')
    }
    seenIds.add(candidate.id)
    seenTags.add(candidate.tag)
    return {
      id: candidate.id,
      tag: candidate.tag,
      post_count: candidate.post_count,
    }
  })
  if (hashtags.length > expectedLimit) {
    throw new Error('Invalid trending hashtag acknowledgement')
  }
  for (let index = 1; index < hashtags.length; index += 1) {
    const previous = hashtags[index - 1]
    const current = hashtags[index]
    const order =
      previous.post_count !== current.post_count
        ? previous.post_count > current.post_count
        : previous.tag !== current.tag
          ? compareCodePoints(previous.tag, current.tag) < 0
          : previous.id < current.id
    if (!order) throw new Error('Invalid trending hashtag ordering')
  }
  return hashtags
}

function decodeHashtagPostsPage(
  value: unknown,
  expected: {
    viewerId: string | null
    tag: string
    limit: number
    offset: number
    sortBy: HashtagPostSort
  }
): HashtagPostsPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'contract',
      'viewer_state',
      'request',
      'posts',
      'total',
      'has_more',
      'next_cursor',
    ]) ||
    value.contract !== 'hashtag_posts_page_v1' ||
    !['anonymous', 'active', 'invalid'].includes(value.viewer_state as string) ||
    !isRecord(value.request) ||
    !hasExactKeys(value.request, ['viewer_id', 'tag', 'limit', 'offset', 'sort_by']) ||
    value.request.tag !== expected.tag ||
    value.request.limit !== expected.limit ||
    value.request.offset !== expected.offset ||
    value.request.sort_by !== expected.sortBy ||
    !Array.isArray(value.posts) ||
    !isSafeNonnegativeInteger(value.total) ||
    typeof value.has_more !== 'boolean' ||
    value.next_cursor !== null
  ) {
    throw new Error('Invalid hashtag page acknowledgement')
  }

  if (value.request.viewer_id !== expected.viewerId) {
    throw new Error('Invalid hashtag page acknowledgement')
  }
  if (value.viewer_state === 'invalid') {
    if (
      expected.viewerId === null ||
      value.posts.length !== 0 ||
      value.total !== 0 ||
      value.has_more !== false
    ) {
      throw new Error('Invalid hashtag page acknowledgement')
    }
    throw new HashtagViewerRejectedError()
  }
  if (value.viewer_state !== (expected.viewerId === null ? 'anonymous' : 'active')) {
    throw new Error('Invalid hashtag page acknowledgement')
  }

  const seenPostIds = new Set<string>()
  const posts = value.posts.map((candidate) => {
    const post = decodeHashtagPost(candidate)
    if (!post || seenPostIds.has(post.id)) {
      throw new Error('Invalid hashtag post row')
    }
    seenPostIds.add(post.id)
    return {
      ...post,
      author: {
        id: post.author_id,
        handle: post.author_handle,
        avatar_url: post.author_avatar_url,
      },
    }
  })

  const expectedPageLength = Math.min(expected.limit, Math.max(value.total - expected.offset, 0))
  if (
    posts.length !== expectedPageLength ||
    value.has_more !== expected.offset + posts.length < value.total
  ) {
    throw new Error('Inconsistent hashtag page acknowledgement')
  }
  for (let index = 1; index < posts.length; index += 1) {
    if (!hashtagPostPrecedes(posts[index - 1], posts[index], expected.sortBy)) {
      throw new Error('Invalid hashtag post ordering')
    }
  }

  return {
    posts,
    tag: expected.tag,
    total: value.total,
    has_more: value.has_more,
    next_cursor: null,
  }
}

/**
 * Extract hashtag strings from text content.
 * Returns unique, lowercased tags.
 */
export function extractHashtags(text: string): string[] {
  if (!text) return []
  const matches = text.matchAll(HASHTAG_REGEX)
  const tags = new Set<string>()
  for (const m of matches) {
    try {
      tags.add(canonicalizeHashtag(m[1]))
    } catch {
      // Some Unicode uppercase forms lowercase into combining-mark sequences
      // that are outside the persisted hashtag alphabet. Never enqueue a tag
      // that the database canonical constraint must reject.
    }
  }
  return Array.from(tags)
}

/**
 * Extract hashtags from content, upsert into hashtags table,
 * and create post_hashtags join rows.
 */
export async function extractAndSyncHashtags(
  supabase: SupabaseClient,
  postId: string,
  content: string
): Promise<void> {
  const tags = extractHashtags(content)
  if (tags.length === 0) return

  try {
    // Upsert all tags (ON CONFLICT do nothing for the insert, we'll increment below)
    const { data: upsertedTags, error: upsertError } = await supabase
      .from('hashtags')
      .upsert(
        tags.map((tag) => ({ tag })),
        { onConflict: 'tag', ignoreDuplicates: true }
      )
      .select('id, tag')

    if (upsertError) {
      logger.error('[hashtags] upsert error:', upsertError)
      return
    }

    // If upsert returned nothing (all existing), fetch them
    let hashtagRows = upsertedTags || []
    if (hashtagRows.length < tags.length) {
      const { data: existingTags, error: existingTagsError } = await supabase
        .from('hashtags')
        .select('id, tag')
        .in('tag', tags)
      if (existingTagsError)
        logger.warn(
          '[extractAndSyncHashtags] hashtags query error (drift?):',
          existingTagsError.message
        )
      hashtagRows = existingTags || []
    }

    if (hashtagRows.length === 0) return

    // Insert join rows
    const joinRows = hashtagRows.map((h: { id: string }) => ({
      post_id: postId,
      hashtag_id: h.id,
    }))

    const { error: joinError } = await supabase
      .from('post_hashtags')
      .upsert(joinRows, { onConflict: 'post_id,hashtag_id', ignoreDuplicates: true })

    if (joinError) {
      logger.error('[hashtags] join insert error:', joinError)
      return
    }

    // Recompute post_count via single RPC (1 query replaces N+1 updates).
    // Uses a server-side SQL function that does:
    //   UPDATE hashtags SET post_count = sub.cnt
    //   FROM (SELECT hashtag_id, count(*) cnt FROM post_hashtags WHERE hashtag_id = ANY($1) GROUP BY 1) sub
    //   WHERE hashtags.id = sub.hashtag_id
    const hashtagIds = hashtagRows.map((h) => h.id)
    const { error: countError } = await supabase.rpc('recount_hashtag_posts', {
      hashtag_ids: hashtagIds,
    })
    if (countError) {
      // Fallback: single IN-based read + single batch upsert
      const { data: counts, error: countsError } = await supabase
        .from('post_hashtags')
        .select('hashtag_id')
        .in('hashtag_id', hashtagIds)
      if (countsError)
        logger.warn(
          '[extractAndSyncHashtags] post_hashtags count query error (drift?):',
          countsError.message
        )

      const countMap = new Map<string, number>()
      for (const row of counts || []) {
        const id = row.hashtag_id as string
        countMap.set(id, (countMap.get(id) || 0) + 1)
      }

      const updates = hashtagIds.map((id) => ({
        id,
        post_count: countMap.get(id) || 0,
      }))
      await supabase.from('hashtags').upsert(updates, { onConflict: 'id' })
    }
  } catch (err) {
    logger.error('[hashtags] sync failed:', err)
  }
}

/**
 * Get trending hashtags (top N by post_count).
 */
export async function getTrendingHashtags(
  supabase: SupabaseClient,
  limit: number = 20
): Promise<TrendingHashtag[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Hashtag limit must be an integer between 1 and 100')
  }

  const { data, error } = await supabase.rpc('get_trending_hashtags_public', {
    p_limit: limit,
  })

  if (error) {
    logger.error('[hashtags] trending query error:', error)
    throw error
  }

  return decodeTrendingHashtags(data, limit)
}

/**
 * Get posts for a specific hashtag, with pagination.
 */
export async function getPostsByHashtag(
  supabase: SupabaseClient,
  tag: string,
  options: {
    limit?: number
    offset?: number
    sort_by?: HashtagPostSort
    viewer_id?: string | null
  } = {}
): Promise<HashtagPostsPage> {
  const { limit = 20, offset = 0, sort_by = 'created_at', viewer_id = null } = options
  const normalizedTag = canonicalizeHashtag(tag)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Hashtag limit must be an integer between 1 and 100')
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
    throw new TypeError('Hashtag offset must be an integer between 0 and 10000')
  }
  if (sort_by !== 'created_at' && sort_by !== 'hot_score') {
    throw new TypeError('Invalid hashtag sort')
  }
  if (viewer_id !== null && !POSTGRES_UUID_RE.test(viewer_id)) {
    throw new TypeError('Invalid hashtag viewer identity')
  }

  const { data, error } = await supabase.rpc('get_hashtag_posts_page', {
    p_viewer_id: viewer_id,
    p_tag: normalizedTag,
    p_limit: limit,
    p_offset: offset,
    p_sort_by: sort_by,
  })

  if (error) {
    logger.error('[hashtags] posts query error:', error)
    throw error
  }

  return decodeHashtagPostsPage(data, {
    viewerId: viewer_id,
    tag: normalizedTag,
    limit,
    offset,
    sortBy: sort_by,
  })
}
