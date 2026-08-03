import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'
import type { Json } from '@/lib/supabase/database.types'

const logger = createLogger('referral-grant')
const SUCCESS_STATUSES = new Set(['granted', 'already_granted'])

export type ReferralGrantIdentity = {
  sourceKey: string
  grantedAt: string
  metadata: Json
}

function exactGrantStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.status !== 'string') return null
  return record.status
}

/**
 * Grant or extend Pro authority by `days` for the given user, then notify them.
 * The grant RPC owns the durable, immutable source key and extends from the
 * exact current paid/grant boundary. Projection rows are never authority.
 *
 * Shared by the referral qualification cron (deferred friend/advocate grants).
 * Caller markers coordinate qualification; the grant's source key is the
 * final exactly-once financial identity.
 */
export async function grantProDays(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  days: number,
  identity: ReferralGrantIdentity,
  notification: { title: string; message: string }
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('grant_pro_entitlement_days_atomic', {
      p_user_id: userId,
      p_source: 'referral',
      p_source_key: identity.sourceKey,
      p_days: days,
      p_granted_at: identity.grantedAt,
      p_metadata: identity.metadata,
    })
    const status = exactGrantStatus(data)
    if (error || !status || !SUCCESS_STATUSES.has(status)) {
      logger.error('Atomic referral entitlement grant failed', {
        code: error?.code,
        sourceKey: identity.sourceKey,
        status,
        userId,
      })
      return false
    }

    if (status === 'granted') {
      sendNotification(
        supabase,
        {
          user_id: userId,
          type: 'referral_reward',
          title: notification.title,
          message: notification.message,
          link: '/settings',
          reference_id: identity.sourceKey,
        },
        'Referral reward notification'
      )
    }
    return true
  } catch (err) {
    logger.error('Failed to grant Pro days:', err)
    return false
  }
}
