/**
 * GET /api/account
 *
 * Returns the current user's account info (profile, subscription tier).
 * Requires authentication.
 */

import { withAuth } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

type ActiveAccountSubscription = {
  user_id: string
  tier: string
  status: string
  current_period_end: string | null
}

function accountSubscription(
  value: unknown,
  expectedUserId: string
): { tier: 'free' | 'pro'; expires_at: string | null } | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Account subscription lookup returned an invalid row')
  }
  const subscription = value as ActiveAccountSubscription
  if (
    subscription.user_id !== expectedUserId ||
    (subscription.status !== 'active' && subscription.status !== 'trialing') ||
    !['free', 'pro', 'elite'].includes(subscription.tier) ||
    (subscription.current_period_end !== null &&
      (typeof subscription.current_period_end !== 'string' ||
        !Number.isFinite(Date.parse(subscription.current_period_end))))
  ) {
    throw new Error('Account subscription lookup returned an inconsistent row')
  }
  return {
    tier: subscription.tier === 'pro' || subscription.tier === 'elite' ? 'pro' : 'free',
    expires_at: subscription.current_period_end,
  }
}

export const GET = withAuth(
  async ({ user, supabase }) => {
    const [profileResult, subscriptionResult] = await Promise.all([
      supabase
        .from('user_profiles')
        // user_profiles has no display_name column — selecting it 400s with 42703
        .select('id, handle, avatar_url, bio, created_at')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('subscriptions')
        .select('user_id, tier, status, current_period_end')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing'])
        .order('created_at', { ascending: false })
        .limit(2)
        .maybeSingle(),
    ])

    if (profileResult.error) throw new Error('Account profile lookup failed')
    if (!profileResult.data || profileResult.data.id !== user.id) {
      throw new Error('Account profile lookup returned an inconsistent row')
    }
    if (subscriptionResult.error) throw new Error('Account subscription lookup failed')
    const subscription = accountSubscription(subscriptionResult.data, user.id)

    return success(
      {
        user: {
          id: user.id,
          email: user.email,
          profile: profileResult.data,
          subscription: subscription ?? { tier: 'free', expires_at: null },
        },
      },
      200,
      { 'Cache-Control': 'private, no-store' }
    )
  },
  { name: 'account', rateLimit: 'authenticated' }
)
