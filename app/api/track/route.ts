/**
 * Behavioral tracking API
 * POST: Record user interactions (impression, click, dwell)
 * Writes to user_interactions table and updates posts.impression_count
 */

import { NextRequest } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('track-api')

const VALID_ACTIONS = ['impression', 'click', 'dwell'] as const

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return new Response(null, { status: 204 })
    }

    let body: { type?: string; post_id?: string; metadata?: Record<string, unknown> }
    try {
      body = await request.json()
    } catch {
      return new Response(null, { status: 204 })
    }

    const { type, post_id, metadata } = body

    if (!type || !post_id || !(VALID_ACTIONS as readonly string[]).includes(type)) {
      return new Response(null, { status: 204 })
    }

    const supabase = getSupabaseAdmin()

    // Insert interaction record
    const { error: insertError } = await supabase.from('user_interactions').insert({
      user_id: user.id,
      target_type: 'post',
      target_id: post_id,
      action: type,
      metadata: metadata || null,
    })

    if (insertError) {
      logger.warn('Failed to insert interaction', { error: insertError.message })
    }

    // Increment impression_count on the post
    if (type === 'impression') {
      // Read current count and increment (simple approach for low volume)
      const { data: post } = await supabase
        .from('posts')
        .select('impression_count')
        .eq('id', post_id)
        .single()

      if (post) {
        await supabase
          .from('posts')
          .update({ impression_count: (post.impression_count || 0) + 1 })
          .eq('id', post_id)
      }
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    logger.error('Track API error', { error: String(error) })
    return new Response(null, { status: 204 })
  }
}
