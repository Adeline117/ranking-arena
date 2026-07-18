/**
 * Behavioral tracking API
 * POST: Record user interactions (impression, click, dwell)
 * Writes to user_interactions table and updates posts.impression_count
 */

import { NextRequest } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { updateCount } from '@/lib/services/counters'
import { z } from 'zod'

const logger = createLogger('track-api')

const TrackSchema = z.object({
  type: z.enum(['impression', 'click', 'dwell']),
  post_id: z.string().min(1),
  metadata: z.record(z.string(), z.json()).optional(),
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

    const supabase = getSupabaseAdmin()

    // Insert interaction record. A partial UNIQUE index enforces one
    // 'impression' row per (user, target) — a duplicate returns 23505, which
    // is our "already counted" signal so the count bump below is skipped.
    const { error: insertError } = await supabase.from('user_interactions').insert({
      user_id: user.id,
      target_type: 'post',
      target_id: post_id,
      action: type,
      metadata: metadata || null,
    })

    const isDuplicateImpression = insertError?.code === '23505'
    if (insertError && !isDuplicateImpression) {
      logger.warn('Failed to insert interaction', { error: insertError.message })
    }

    // Bump impression_count ONLY on the first impression from this user for this
    // post (insert succeeded). Atomic RPC — no read-then-write lost-update race,
    // and per-(user,post) dedup prevents feed-ranking inflation by bot swarms.
    if (type === 'impression' && !insertError) {
      updateCount(supabase, 'increment_impression_count', { post_id }, 'Increment impression count')
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    logger.error('Track API error', { error: String(error) })
    return new Response(null, { status: 204 })
  }
}
