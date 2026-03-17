/**
 * GET /api/account
 *
 * Returns the current user's account info (profile, subscription tier).
 * Requires authentication.
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const [profileResult, subscriptionResult] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, handle, display_name, avatar_url, bio, created_at')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('subscriptions')
        .select('tier, expires_at')
        .eq('user_id', user.id)
        .maybeSingle(),
    ])

    return success({
      user: {
        id: user.id,
        email: user.email,
        profile: profileResult.data || null,
        subscription: subscriptionResult.data || { tier: 'free', expires_at: null },
      },
    })
  } catch (err: unknown) {
    return handleError(err)
  }
}
