/**
 * Cleanup Deleted Accounts Cron
 * GET /api/cron/cleanup-deleted-accounts
 *
 * Runs daily. Hard-deletes users whose 30-day grace period has passed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorized } from '@/lib/cron/utils'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Find users whose deletion grace period has passed
    const { data: expiredAccounts, error } = await supabase
      .from('user_profiles')
      .select('id, original_email')
      .not('deleted_at', 'is', null)
      .lt('deletion_scheduled_at', new Date().toISOString())

    if (error) {
      logger.error('[cleanup-deleted-accounts] Query error:', error)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!expiredAccounts || expiredAccounts.length === 0) {
      return NextResponse.json({ message: 'No accounts to cleanup', deleted: 0 })
    }

    const errors: string[] = []

    // 并行处理删除，限制并发数避免过载
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

      // 统计结果
      for (let j = 0; j < results.length; j++) {
        const result = results[j]
        if (result.status === 'fulfilled') {
          deleted++
        } else {
          errors.push(`Failed to delete ${batch[j].id}: ${result.reason}`)
        }
      }
    }


    return NextResponse.json({
      message: `Cleanup complete`,
      total: expiredAccounts.length,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error: unknown) {
    logger.error('[cleanup-deleted-accounts] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
