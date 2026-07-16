/**
 * Emoji Reactions API (separate from like/dislike)
 * POST /api/posts/[id]/emoji-react - Toggle emoji reaction
 * GET /api/posts/[id]/emoji-react - Get aggregated emoji counts
 */

import { NextResponse } from 'next/server'
import { success } from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import logger from '@/lib/logger'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'

// Allowed emoji set (crypto-relevant, keep it focused)
const ALLOWED_EMOJIS = new Set([
  '👍',
  '🔥',
  '💎',
  '🚀',
  '❤️',
  '👀',
  '🎯',
  '💰',
  '📈',
  '📉',
  '🤔',
  '😂',
])

/** Extract post id from URL path */
function extractPostId(url: string): string | undefined {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  const postId = postsIdx >= 0 ? pathParts[postsIdx + 1] : undefined
  return postId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(postId)
    ? postId
    : undefined
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postId = extractPostId(request.url)
    const sb = supabase

    if (!postId) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const emoji = body.emoji as string

    if (!emoji || !ALLOWED_EMOJIS.has(emoji)) {
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 })
    }

    if (!(await canServiceActorReadPost(sb, postId, user.id))) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    // Check if reaction exists
    const { data: existing, error: existingError } = await sb
      .from('post_emoji_reactions')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', user.id)
      .eq('emoji', emoji)
      .maybeSingle()

    if (existingError) {
      logger.error('[emoji-react] existing reaction lookup failed', {
        postId,
        error: existingError.message,
      })
      return NextResponse.json({ error: 'Failed to check reaction' }, { status: 500 })
    }

    if (existing) {
      // Remove (toggle off)
      const { error } = await sb
        .from('post_emoji_reactions')
        .delete()
        .eq('id', existing.id)
        .eq('post_id', postId)
        .eq('user_id', user.id)
        .eq('emoji', emoji)
      if (error) {
        logger.error('[emoji-react] toggle-off delete failed', { postId, error: error.message })
        return NextResponse.json({ error: 'Failed to remove reaction' }, { status: 500 })
      }
    } else {
      // Add
      const { error } = await sb.from('post_emoji_reactions').insert({
        post_id: postId,
        user_id: user.id,
        emoji,
      })
      if (error) {
        logger.error('[emoji-react] add insert failed', { postId, error: error.message })
        return NextResponse.json({ error: 'Failed to add reaction' }, { status: 500 })
      }
    }

    // Get updated aggregated counts
    const { data: reactions, error: reactionsError } = await sb
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)

    if (reactionsError) {
      logger.error('[emoji-react] aggregate lookup failed', {
        postId,
        error: reactionsError.message,
      })
      return NextResponse.json({ error: 'Failed to load reactions' }, { status: 500 })
    }

    const counts: Record<string, number> = {}
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
    }

    // Get user's own reactions
    const { data: userReactions, error: userReactionsError } = await sb
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)
      .eq('user_id', user.id)

    if (userReactionsError) {
      logger.error('[emoji-react] viewer reaction lookup failed', {
        postId,
        error: userReactionsError.message,
      })
      return NextResponse.json({ error: 'Failed to load reactions' }, { status: 500 })
    }

    return success({
      action: existing ? 'removed' : 'added',
      emoji,
      counts,
      userEmojis: (userReactions || []).map((r: { emoji: string }) => r.emoji),
    })
  },
  { name: 'posts/emoji-react-post', rateLimit: 'write' }
)

export const GET = withPublic(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postId = extractPostId(request.url)
    const sb = supabase

    if (!postId) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }
    if (request.headers.get('authorization') && !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!(await canServiceActorReadPost(sb, postId, user?.id ?? null))) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const { data: reactions, error: reactionsError } = await sb
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)

    if (reactionsError) {
      logger.error('[emoji-react] aggregate lookup failed', {
        postId,
        error: reactionsError.message,
      })
      return NextResponse.json({ error: 'Failed to load reactions' }, { status: 500 })
    }

    const counts: Record<string, number> = {}
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
    }

    let userEmojis: string[] = []
    if (user) {
      const { data: userReactions, error: userReactionsError } = await sb
        .from('post_emoji_reactions')
        .select('emoji')
        .eq('post_id', postId)
        .eq('user_id', user.id)
      if (userReactionsError) {
        logger.error('[emoji-react] viewer reaction lookup failed', {
          postId,
          error: userReactionsError.message,
        })
        return NextResponse.json({ error: 'Failed to load reactions' }, { status: 500 })
      }
      userEmojis = (userReactions || []).map((r: { emoji: string }) => r.emoji)
    }

    return success({ counts, userEmojis })
  },
  { name: 'posts/emoji-react-get', rateLimit: 'read', readsAuth: true }
)
