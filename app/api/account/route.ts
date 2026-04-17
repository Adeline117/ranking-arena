/**
 * GET /api/account
 *
 * Returns the current user's account info (profile, subscription tier).
 * Requires authentication.
 */

import { withAuth } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

export const GET = withAuth(async ({ user, supabase }) => {
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
}, { name: 'account', rateLimit: 'authenticated' })
