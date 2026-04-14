/**
 * Behavioral tracking API
 * POST: Record user interactions (impression, click, dwell)
 * Writes to user_interactions table and updates posts.impression_count
 */

import { NextRequest } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { z } from 'zod'

const logger = createLogger('track-api')

const TrackSchema = z.object({
  type: z.enum(['impression', 'click', 'dwell']),
  post_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return new Response(null, { status: 204 })
    }

    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return new Response(null, { status: 204 })
    }

    const parsed = TrackSchema.safeParse(raw)
    if (!parsed.success) {
      return new Response(null, { status: 204 })
    }
    const { type, post_id, metadata } = parsed.data

    const supabase = getSupabaseAdmin() as SupabaseClient

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

    // Increment impression_count on the post (best-effort, non-critical)
    // Uses read-then-write pattern — acceptable for approximate impression tracking
    if (type === 'impression') {
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
