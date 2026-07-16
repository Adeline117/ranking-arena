/**
 * Hashtag data layer
 * - Extract hashtags from post content
 * - Upsert into hashtags table
 * - Link via post_hashtags join table
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { filterServiceReadablePostRows } from './service-post-audience'

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
  options: { limit?: number; offset?: number; sort_by?: 'hot_score' | 'created_at' } = {}
): Promise<{ posts: unknown[]; total: number }> {
  const { limit = 20, offset = 0, sort_by = 'created_at' } = options

  // First find the hashtag
  const { data: hashtag, error: hashtagError } = await supabase
    .from('hashtags')
    .select('id')
    .eq('tag', tag.toLowerCase())
    .maybeSingle()
  if (hashtagError)
    logger.warn('[getPostsByHashtag] hashtags query error (drift?):', hashtagError.message)

  if (!hashtag) return { posts: [], total: 0 }

  // Get post IDs from join table
  // KEEP 'exact' — powers pagination for the /tag/:name posts listing.
  // Scoped to a single hashtag via (hashtag_id) index → cheap.
  const {
    data: joinRows,
    count,
    error: joinRowsError,
  } = await supabase
    .from('post_hashtags')
    .select('post_id', { count: 'exact' })
    .eq('hashtag_id', hashtag.id)
  if (joinRowsError)
    logger.warn('[getPostsByHashtag] post_hashtags query error (drift?):', joinRowsError.message)

  if (!joinRows || joinRows.length === 0) return { posts: [], total: 0 }

  const postIds = joinRows.map((r: { post_id: string }) => r.post_id)

  // Fetch posts. posts.author_id has no FK in prod, so the
  // users!posts_author_id_fkey embed fails with PGRST200 (and the users table
  // has no handle/display_name/avatar_url columns anyway) — two-step lookup
  // via user_profiles instead, keeping the `author` response key shape.
  const query = supabase
    .from('posts')
    .select('*')
    .in('id', postIds)
    .order(sort_by, { ascending: false })
    .range(offset, offset + limit - 1)

  const { data: posts, error } = await query

  if (error) {
    logger.error('[hashtags] posts query error:', error)
    return { posts: [], total: 0 }
  }

  const candidateRows = (posts || []).filter(
    (post): post is Record<string, unknown> & { id: string } => typeof post.id === 'string'
  )
  const rows = await filterServiceReadablePostRows(supabase, candidateRows, null)
  const authorIds = [...new Set(rows.map((p) => p.author_id as string).filter(Boolean))]
  const { data: profiles, error: profilesError } = authorIds.length
    ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', authorIds)
    : { data: null, error: null }
  if (profilesError)
    logger.warn('[getPostsByHashtag] user_profiles query error (drift?):', profilesError.message)
  const profileById = new Map(
    (profiles || []).map((p: Record<string, unknown>) => [p.id as string, p])
  )
  const withAuthors = rows.map((p) => ({
    ...p,
    author: profileById.get(p.author_id as string) ?? null,
  }))

  return { posts: withAuthors, total: count || 0 }
}
