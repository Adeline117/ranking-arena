import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'

const logger = createLogger('referral-grant')

/**
 * Grant or extend a Pro subscription by `days` for the given user, then notify
 * them. Best-effort: DB errors are logged (never silently swallowed) but never
 * thrown, so a grant failure can't break the caller's flow.
 *
 * Shared by the referral qualification cron (deferred friend/advocate grants).
 * Idempotency for one-time rewards is enforced by the CALLER (referral_rewards
 * marker for the advocate; per-attribution friend_granted flag for the friend).
 */
export async function grantProDays(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  days: number,
  notification: { title: string; message: string }
): Promise<void> {
  try {
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('id, current_period_end, status')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const now = new Date()

    if (existingSub) {
      const currentEnd = existingSub.current_period_end
        ? new Date(existingSub.current_period_end)
        : now
      const newEnd = new Date(Math.max(currentEnd.getTime(), now.getTime()))
      newEnd.setDate(newEnd.getDate() + days)

      const { error: updateError } = await supabase
        .from('subscriptions')
        .update({ current_period_end: newEnd.toISOString() })
        .eq('id', existingSub.id)
      if (updateError) {
        logger.error('Failed to extend subscription:', updateError.message)
        return
      }
    } else {
      const endDate = new Date(now)
      endDate.setDate(endDate.getDate() + days)

      const { error: insertError } = await supabase.from('subscriptions').insert({
        user_id: userId,
        tier: 'pro',
        status: 'active',
        current_period_start: now.toISOString(),
        current_period_end: endDate.toISOString(),
      })
      if (insertError) {
        logger.error('Failed to create referral subscription:', insertError.message)
        return
      }

      const { error: profileError } = await supabase
        .from('user_profiles')
        .update({ subscription_tier: 'pro', is_pro: true })
        .eq('id', userId)
      if (profileError) {
        logger.error('Failed to update profile Pro flags:', profileError.message)
      }
    }

    sendNotification(
      supabase,
      {
        user_id: userId,
        type: 'referral_reward',
        title: notification.title,
        message: notification.message,
        link: '/settings',
      },
      'Referral reward notification'
    )
  } catch (err) {
    logger.error('Failed to grant Pro days:', err)
  }
}
