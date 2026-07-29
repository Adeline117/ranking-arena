/**
 * GET /api/traders/claim/status?trader_id=xxx&source=binance
 *
 * Check if a specific trader has been claimed/verified.
 * Public endpoint (no auth required) - used to show verified badge on profiles.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, success, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  response.headers.set('Pragma', 'no-cache')
  return response
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return noStore(rateLimitResponse)

  try {
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('trader_id')
    const source = searchParams.get('source')

    if (!traderId || !source) {
      return noStore(success({ is_verified: false }))
    }

    const supabase = getSupabaseAdmin()

    const { data: verified, error: verifiedError } = await supabase
      .from('verified_traders')
      .select(
        'id, user_id, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url, profile_version'
      )
      .eq('trader_id', traderId)
      .eq('source', source)
      .maybeSingle()

    if (verifiedError) throw verifiedError

    if (!verified) {
      return noStore(success({ trader_id: traderId, source, is_verified: false }))
    }

    return noStore(
      success({
        trader_id: traderId,
        source,
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
          profile_version: verified.profile_version,
        },
      })
    )
  } catch (error: unknown) {
    return noStore(handleError(error, 'claim status GET'))
  }
}
