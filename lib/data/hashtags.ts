/**
 * Hashtag data layer
 * - Extract hashtags from post content
 * - Upsert into hashtags table
 * - Link via post_hashtags join table
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { filterServiceReadablePostRowsStrict } from './service-post-audience'

// Unicode-aware: \w 是 ASCII-only,会把 #比特币 这类 CJK 标签静默丢掉
// (2026-07-03 修复,与 lib/utils/content.ts 的 linkify regex 保持同步)。
const HASHTAG_REGEX = /#([\p{L}\p{N}_]{1,30})/gu

/**
 * Extract hashtag strings from text content.
 * Returns unique, lowercased tags.
 */
export function extractHashtags(text: string): string[] {
  if (!text) return []
  const matches = text.matchAll(HASHTAG_REGEX)
  const tags = new Set<string>()
  for (const m of matches) {
    tags.add(m[1].toLowerCase())
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
): Promise<Array<{ id: string; tag: string; post_count: number }>> {
  const { data, error } = await supabase
    .from('hashtags')
    .select('id, tag, post_count')
    .gt('post_count', 0)
    .order('post_count', { ascending: false })
    .limit(limit)

  if (error) {
    logger.error('[hashtags] trending query error:', error)
    return []
  }

  return data || []
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
    sort_by?: 'hot_score' | 'created_at'
    viewer_id?: string | null
  } = {}
): Promise<{
  posts: Array<Record<string, unknown> & { id: string }>
  total: number | null
  has_more: boolean
}> {
  const { limit = 20, offset = 0, sort_by = 'created_at', viewer_id = null } = options

  // The route caps offset at 10k. Keep the data layer bounded as well so a
  // direct caller cannot turn audience filtering into an unbounded service
  // scan. Reaching the bound without establishing the requested page is an
  // authority/read failure, not an empty result.
  const maxCandidateBatchSize = 100
  const minCandidateBatchSize = 32
  const maxRawCandidates = 10_400

  // First find the hashtag
  const { data: hashtag, error: hashtagError } = await supabase
    .from('hashtags')
    .select('id')
    .eq('tag', tag.toLowerCase())
    .maybeSingle()
  if (hashtagError) throw hashtagError

  if (!hashtag) return { posts: [], total: 0, has_more: false }
  if (
    typeof hashtag !== 'object' ||
    Array.isArray(hashtag) ||
    typeof (hashtag as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('Hashtag query returned invalid data')
  }
  const hashtagId = (hashtag as { id: string }).id

  // The service client bypasses posts RLS. Page offsets therefore have to be
  // applied after canonical audience authorization, not to raw candidates.
  // Query posts through the canonical join FK in deterministic order, then
  // scan until we have one authorized look-ahead row or exhaust the source.
  const readableRows: Array<Record<string, unknown> & { id: string }> = []
  const seenPostIds = new Set<string>()
  const wantedReadableRows = offset + limit + 1
  let rawOffset = 0
  let sourceExhausted = false

  while (readableRows.length < wantedReadableRows && rawOffset < maxRawCandidates) {
    const remainingReadableRows = wantedReadableRows - readableRows.length
    const candidateBatchSize = Math.min(
      maxCandidateBatchSize,
      Math.max(minCandidateBatchSize, remainingReadableRows),
      maxRawCandidates - rawOffset
    )
    const { data: candidates, error: candidatesError } = await supabase
      .from('posts')
      .select('*, post_hashtags!inner(hashtag_id)')
      .eq('post_hashtags.hashtag_id', hashtagId)
      .order(sort_by, { ascending: false })
      .order('id', { ascending: false })
      .range(rawOffset, rawOffset + candidateBatchSize - 1)

    if (candidatesError) throw candidatesError
    if (!Array.isArray(candidates)) {
      throw new Error('Hashtag posts query returned invalid data')
    }

    const candidateRows = candidates.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('Hashtag posts query returned invalid data')
      }
      const row = candidate as Record<string, unknown>
      const postId = row.id
      const joins = row.post_hashtags
      if (
        typeof postId !== 'string' ||
        seenPostIds.has(postId) ||
        !Array.isArray(joins) ||
        joins.length === 0 ||
        !joins.every(
          (join) =>
            join !== null &&
            typeof join === 'object' &&
            !Array.isArray(join) &&
            (join as { hashtag_id?: unknown }).hashtag_id === hashtagId
        )
      ) {
        throw new Error('Hashtag posts query returned invalid data')
      }
      seenPostIds.add(postId)
      const { post_hashtags: _postHashtags, ...post } = row
      return post as Record<string, unknown> & { id: string }
    })

    const authorizedRows = await filterServiceReadablePostRowsStrict(
      supabase,
      candidateRows,
      viewer_id
    )
    readableRows.push(...authorizedRows)
    rawOffset += candidateRows.length

    if (candidateRows.length < candidateBatchSize) {
      sourceExhausted = true
      break
    }
  }

  if (!sourceExhausted && readableRows.length < wantedReadableRows) {
    throw new Error('Hashtag audience scan exceeded the bounded read window')
  }

  const has_more = readableRows.length > offset + limit
  const rows = readableRows.slice(offset, offset + limit)
  const total = sourceExhausted ? readableRows.length : null

  // posts.author_id has no usable profile FK in production, so keep the
  // response's `author` shape via a strict second read of user_profiles.
  const authorIds = [
    ...new Set(
      rows
        .map((post) => post.author_id)
        .filter((authorId): authorId is string => typeof authorId === 'string')
    ),
  ]
  const { data: profiles, error: profilesError } = authorIds.length
    ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', authorIds)
    : { data: [], error: null }
  if (profilesError) throw profilesError
  if (!Array.isArray(profiles)) {
    throw new Error('Hashtag profile query returned invalid data')
  }
  const profileById = new Map<string, Record<string, unknown>>()
  const requestedAuthorIds = new Set(authorIds)
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('Hashtag profile query returned invalid data')
    }
    const row = profile as Record<string, unknown>
    if (typeof row.id !== 'string' || !requestedAuthorIds.has(row.id) || profileById.has(row.id)) {
      throw new Error('Hashtag profile query returned invalid data')
    }
    profileById.set(row.id, row)
  }
  const withAuthors = rows.map((p) => ({
    ...p,
    author: profileById.get(p.author_id as string) ?? null,
  }))

  return { posts: withAuthors, total, has_more }
}
