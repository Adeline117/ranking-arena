/**
 * Emoji Reactions API (separate from like/dislike)
 * POST /api/posts/[id]/emoji-react - Toggle emoji reaction
 * GET /api/posts/[id]/emoji-react - Get aggregated emoji counts
 */

import { NextResponse } from 'next/server'
import {
  success,
  handleError,
} from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import type { SupabaseClient } from '@supabase/supabase-js'
import { socialFeatureGuard } from '@/lib/features'

// Allowed emoji set (crypto-relevant, keep it focused)
const ALLOWED_EMOJIS = new Set(['👍', '🔥', '💎', '🚀', '❤️', '👀', '🎯', '💰', '📈', '📉', '🤔', '😂'])

/** Extract post id from URL path */
function extractPostId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return pathParts[postsIdx + 1]
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postId = extractPostId(request.url)
    const sb = supabase as SupabaseClient

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }
    const emoji = body.emoji as string

    if (!emoji || !ALLOWED_EMOJIS.has(emoji)) {
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 })
    }

    // Check if reaction exists
    const { data: existing } = await sb
      .from('post_emoji_reactions')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', user.id)
      .eq('emoji', emoji)
      .maybeSingle()

    if (existing) {
      // Remove (toggle off)
      await sb.from('post_emoji_reactions').delete().eq('id', existing.id)
    } else {
      // Add
      await sb.from('post_emoji_reactions').insert({
        post_id: postId,
        user_id: user.id,
        emoji,
      })
    }

    // Get updated aggregated counts
    const { data: reactions } = await sb
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)

    const counts: Record<string, number> = {}
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
    }

    // Get user's own reactions
    const { data: userReactions } = await sb
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)
      .eq('user_id', user.id)

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
  async ({ supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postId = extractPostId(request.url)
    const sb = supabase as SupabaseClient

    const { data: reactions } = await sb
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)

    const counts: Record<string, number> = {}
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
    }

    // Check if user is authenticated to get their own reactions
    let userEmojis: string[] = []
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await sb.auth.getUser(token)
      if (user) {
        const { data: userReactions } = await sb
          .from('post_emoji_reactions')
          .select('emoji')
          .eq('post_id', postId)
          .eq('user_id', user.id)
        userEmojis = (userReactions || []).map((r: { emoji: string }) => r.emoji)
      }
    }

    return success({ counts, userEmojis })
  },
  { name: 'posts/emoji-react-get', rateLimit: 'read' }
)
