/**
 * Cleanup Deleted Accounts Cron
 * GET /api/cron/cleanup-deleted-accounts
 *
 * Runs daily. Hard-deletes users whose 30-day grace period has passed.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron('cleanup-deleted-accounts', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()

  // Find users whose deletion grace period has passed
  const { data: expiredAccounts, error } = await supabase
    .from('user_profiles')
    .select('id, original_email')
    .not('deleted_at', 'is', null)
    .lt('deletion_scheduled_at', new Date().toISOString())

  if (error) {
    logger.error('[cleanup-deleted-accounts] Query error:', error)
    throw error
  }

  if (!expiredAccounts || expiredAccounts.length === 0) {
    return { count: 0, message: 'No accounts to cleanup' }
  }

  const errors: string[] = []

  // Process deletion in batches to avoid overload
  const BATCH_SIZE = 10
  let deleted = 0

  for (let i = 0; i < expiredAccounts.length; i += BATCH_SIZE) {
    const batch = expiredAccounts.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(
      batch.map(async (account) => {
        // Hard delete from auth
        const { error: deleteError } = await supabase.auth.admin.deleteUser(account.id)
        if (deleteError) {
          throw new Error(`Auth delete failed: ${deleteError.message}`)
        }

        // Delete profile data
        const { error: profileError } = await supabase
          .from('user_profiles')
          .delete()
          .eq('id', account.id)

        if (profileError) {
          throw new Error(`Profile delete failed: ${profileError.message}`)
        }

        return account.id
      })
    )

    for (let j = 0; j < results.length; j++) {
      const result = results[j]
      if (result.status === 'fulfilled') {
        deleted++
      } else {
        errors.push(`Failed to delete ${batch[j].id}: ${result.reason}`)
      }
    }
  }

  return {
    count: deleted,
    total: expiredAccounts.length,
    errors: errors.length > 0 ? errors : undefined,
  }
})
