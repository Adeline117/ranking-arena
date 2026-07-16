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

    const { data, error } = await sb.rpc('toggle_post_emoji_reaction_atomic', {
      p_actor_id: user.id,
      p_post_id: postId,
      p_emoji: emoji,
    })

    if (error) {
      logger.error('[emoji-react] atomic toggle failed', {
        postId,
        error: error.message,
      })
      return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
    }

    const result = data as Record<string, unknown>
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }
    if (result.status === 'invalid') {
      return NextResponse.json({ error: 'Invalid reaction request' }, { status: 400 })
    }

    const action = result.action
    const counts = result.counts
    const userEmojis = result.user_emojis
    const validCounts =
      counts &&
      typeof counts === 'object' &&
      !Array.isArray(counts) &&
      Object.entries(counts).every(
        ([key, value]) => ALLOWED_EMOJIS.has(key) && Number.isSafeInteger(value) && value >= 0
      )
    const validUserEmojis =
      Array.isArray(userEmojis) &&
      userEmojis.every((value) => typeof value === 'string' && ALLOWED_EMOJIS.has(value))
    if (
      result.status !== action ||
      (action !== 'added' && action !== 'removed') ||
      result.emoji !== emoji ||
      !validCounts ||
      !validUserEmojis
    ) {
      return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
    }

    return success({
      action,
      emoji,
      counts,
      userEmojis,
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
