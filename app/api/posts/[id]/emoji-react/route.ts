/**
 * Emoji Reactions API (separate from like/dislike)
 * POST /api/posts/[id]/emoji-react - Toggle emoji reaction
 * GET /api/posts/[id]/emoji-react - Get aggregated emoji counts
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string }> }

// Allowed emoji set (crypto-relevant, keep it focused)
const ALLOWED_EMOJIS = new Set(['👍', '🔥', '💎', '🚀', '❤️', '👀', '🎯', '💰', '📈', '📉', '🤔', '😂'])

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id: postId } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    const body = await request.json()
    const emoji = body.emoji as string

    if (!emoji || !ALLOWED_EMOJIS.has(emoji)) {
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 })
    }

    // Check if reaction exists
    const { data: existing } = await supabase
      .from('post_emoji_reactions')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', user.id)
      .eq('emoji', emoji)
      .maybeSingle()

    if (existing) {
      // Remove (toggle off)
      await supabase.from('post_emoji_reactions').delete().eq('id', existing.id)
    } else {
      // Add
      await supabase.from('post_emoji_reactions').insert({
        post_id: postId,
        user_id: user.id,
        emoji,
      })
    }

    // Get updated aggregated counts
    const { data: reactions } = await supabase
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)

    const counts: Record<string, number> = {}
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
    }

    // Get user's own reactions
    const { data: userReactions } = await supabase
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)
      .eq('user_id', user.id)

    return success({
      action: existing ? 'removed' : 'added',
      emoji,
      counts,
      userEmojis: (userReactions || []).map(r => r.emoji),
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { id: postId } = await context.params
    const supabase = getSupabaseAdmin() as SupabaseClient

    const { data: reactions } = await supabase
      .from('post_emoji_reactions')
      .select('emoji')
      .eq('post_id', postId)

    const counts: Record<string, number> = {}
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
    }

    // Check if user is authenticated to get their own reactions
    let userEmojis: string[] = []
    try {
      const user = await requireAuth(request)
      const { data: userReactions } = await supabase
        .from('post_emoji_reactions')
        .select('emoji')
        .eq('post_id', postId)
        .eq('user_id', user.id)
      userEmojis = (userReactions || []).map(r => r.emoji)
    } catch {
      // Not authenticated — just return counts without user state
    }

    return success({ counts, userEmojis })
  } catch (err) {
    return handleError(err)
  }
}
