/**
 * Hashtag data layer
 * - Extract hashtags from post content
 * - Upsert into hashtags table
 * - Link via post_hashtags join table
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const HASHTAG_REGEX = /#(\w{1,30})/g

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
        tags.map(tag => ({ tag })),
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
      const { data: existingTags } = await supabase
        .from('hashtags')
        .select('id, tag')
        .in('tag', tags)
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

    // Increment post_count for each tag
    for (const h of hashtagRows) {
      await supabase.rpc('increment_field', {
        table_name: 'hashtags',
        row_id: h.id,
        field_name: 'post_count',
        amount: 1,
      }).catch(() => {
        // Fallback: direct update if RPC doesn't exist
        supabase
          .from('hashtags')
          .update({ post_count: (supabase as unknown as { sql: unknown }) ? undefined : 1 })
          .eq('id', h.id)
          .then(() => {})
          .catch(() => {})
      })
    }

    // Simpler approach: just count from join table for accuracy
    for (const h of hashtagRows) {
      const { count } = await supabase
        .from('post_hashtags')
        .select('*', { count: 'exact', head: true })
        .eq('hashtag_id', h.id)

      if (count !== null) {
        await supabase
          .from('hashtags')
          .update({ post_count: count })
          .eq('id', h.id)
      }
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
  const { data: hashtag } = await supabase
    .from('hashtags')
    .select('id')
    .eq('tag', tag.toLowerCase())
    .single()

  if (!hashtag) return { posts: [], total: 0 }

  // Get post IDs from join table
  const { data: joinRows, count } = await supabase
    .from('post_hashtags')
    .select('post_id', { count: 'exact' })
    .eq('hashtag_id', hashtag.id)

  if (!joinRows || joinRows.length === 0) return { posts: [], total: 0 }

  const postIds = joinRows.map((r: { post_id: string }) => r.post_id)

  // Fetch posts
  const query = supabase
    .from('posts')
    .select('*, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url)')
    .in('id', postIds)
    .order(sort_by, { ascending: false })
    .range(offset, offset + limit - 1)

  const { data: posts, error } = await query

  if (error) {
    logger.error('[hashtags] posts query error:', error)
    return { posts: [], total: 0 }
  }

  return { posts: posts || [], total: count || 0 }
}
