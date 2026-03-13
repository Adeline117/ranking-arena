/**
 * Cron: Cleanup trader_snapshots_v2 rows older than 365 days
 * Schedule: Daily at 4 AM UTC
 *
 * Deletes in batches of 5000 to avoid long-running transactions.
 * trader_snapshots (v1) and daily_snapshots are permanent — never deleted.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('cleanup-snapshots-v2')
const BATCH_SIZE = 5000
const RETENTION_DAYS = 365

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('cleanup-snapshots-v2')
  const supabase = getSupabaseAdmin()
  let totalDeleted = 0

  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

    // Delete in batches to avoid long transactions
    let batchDeleted = 0
    do {
      const { data, error } = await supabase
        .from('trader_snapshots_v2')
        .delete()
        .lt('created_at', cutoff)
        .limit(BATCH_SIZE)
        .select('id')

      if (error) {
        logger.error('Batch delete error:', error)
        break
      }

      batchDeleted = data?.length ?? 0
      totalDeleted += batchDeleted

      if (batchDeleted > 0) {
        logger.info(`Deleted batch of ${batchDeleted} rows (total: ${totalDeleted})`)
      }
    } while (batchDeleted === BATCH_SIZE)

    logger.info(`Cleanup complete: ${totalDeleted} rows deleted (cutoff: ${cutoff})`)
    await plog.success(totalDeleted)

    return NextResponse.json({
      ok: true,
      deleted: totalDeleted,
      retention_days: RETENTION_DAYS,
      cutoff,
    })
  } catch (error) {
    logger.error('Cleanup failed:', error)
    await plog.error(error)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
