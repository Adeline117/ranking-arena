/**
 * Admin audit-log writer.
 *
 * The audit row is secondary to the admin action (which has already been
 * applied), so a failed insert must not fail the request — but it must never
 * be silent either: a missing audit trail is a compliance gap that has to be
 * visible in error monitoring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-audit-log')

export type AdminLogEntry = Database['public']['Tables']['admin_logs']['Insert']

/** Insert an admin_logs row; returns false (and logs) on failure, never throws. */
export async function recordAdminLog(
  supabase: SupabaseClient,
  entry: AdminLogEntry
): Promise<boolean> {
  try {
    const { error } = await supabase.from('admin_logs').insert(entry)
    if (error) {
      logger.error('admin_logs insert failed — audit trail missing for applied action', {
        action: entry.action,
        adminId: entry.admin_id,
        targetType: entry.target_type,
        targetId: entry.target_id,
        error: error.message,
      })
      return false
    }
    return true
  } catch (err) {
    logger.error('admin_logs insert threw — audit trail missing for applied action', {
      action: entry.action,
      adminId: entry.admin_id,
      targetId: entry.target_id,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
