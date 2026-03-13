/**
 * GET /api/traders/claim/status?trader_id=xxx&source=binance
 *
 * Check if a specific trader has been claimed/verified.
 * Public endpoint (no auth required) - used to show verified badge on profiles.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin, success, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('trader_id')
    const source = searchParams.get('source')

    if (!traderId || !source) {
      return success({ is_verified: false })
    }

    const supabase = getSupabaseAdmin()

    const { data: verified } = await supabase
      .from('verified_traders')
      .select('id, user_id, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url')
      .eq('trader_id', traderId)
      .eq('source', source)
      .maybeSingle()

    if (!verified) {
      return success({ is_verified: false })
    }

    return success({
      is_verified: true,
      owner_id: verified.user_id,
      profile: {
        display_name: verified.display_name,
        bio: verified.bio,
        avatar_url: verified.avatar_url,
        twitter_url: verified.twitter_url,
        telegram_url: verified.telegram_url,
        discord_url: verified.discord_url,
        website_url: verified.website_url,
      },
    })
  } catch (error: unknown) {
    return handleError(error, 'claim status GET')
  }
}
