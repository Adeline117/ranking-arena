/**
 * GET /api/account
 *
 * Returns the current user's account info (profile, subscription tier).
 * Requires authentication.
 */

import { withAuth } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

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
        // subscriptions 无 expires_at 列(用 current_period_end)——旧 select 400→
        // 订阅永远读不出→account 永远显示 tier:free(被 PRO_FREE_PROMO 掩盖)
        .select('tier, current_period_end')
        .eq('user_id', user.id)
        .maybeSingle(),
    ])

    return success({
      user: {
        id: user.id,
        email: user.email,
        profile: profileResult.data || null,
        subscription: subscriptionResult.data
          ? {
              tier: subscriptionResult.data.tier,
              expires_at: subscriptionResult.data.current_period_end,
            }
          : { tier: 'free', expires_at: null },
      },
    })
  },
  { name: 'account', rateLimit: 'authenticated' }
)
