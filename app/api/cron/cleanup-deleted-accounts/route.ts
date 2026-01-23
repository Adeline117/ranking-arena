/**
 * Cleanup Deleted Accounts Cron
 * GET /api/cron/cleanup-deleted-accounts
 *
 * Runs daily. Hard-deletes users whose 30-day grace period has passed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorized } from '@/lib/cron/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
      console.error('[cleanup-deleted-accounts] Query error:', error)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    if (!expiredAccounts || expiredAccounts.length === 0) {
      return NextResponse.json({ message: 'No accounts to cleanup', deleted: 0 })
    }

    let deleted = 0
    const errors: string[] = []

    for (const account of expiredAccounts) {
      try {
        // Hard delete from auth
        const { error: deleteError } = await supabase.auth.admin.deleteUser(account.id)
        if (deleteError) {
          errors.push(`Failed to delete ${account.id}: ${deleteError.message}`)
          continue
        }

        // Delete profile data
        await supabase
          .from('user_profiles')
          .delete()
          .eq('id', account.id)

        deleted++
      } catch (err) {
        errors.push(`Error deleting ${account.id}: ${err}`)
      }
    }

    console.log(`[cleanup-deleted-accounts] Deleted ${deleted}/${expiredAccounts.length} accounts`)

    return NextResponse.json({
      message: `Cleanup complete`,
      total: expiredAccounts.length,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error('[cleanup-deleted-accounts] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
