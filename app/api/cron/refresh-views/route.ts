/**
 * Cron: Refresh materialized views
 * Schedule: Every hour at :05 (5 * * * *)
 * Refreshes mv_hourly_prices and mv_daily_rankings
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = createLogger('refresh-views')

export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (!process.env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const start = Date.now()
  const plog = await PipelineLogger.start('refresh-views')

  try {
    const { error } = await supabase.rpc('refresh_materialized_views')

    if (error) {
      logger.error('Failed to refresh materialized views', { error: error.message })
      await plog.error(new Error(error.message))
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const duration = Date.now() - start
    logger.info('Materialized views refreshed', { duration })

    await plog.success(2, { views: ['mv_hourly_prices', 'mv_daily_rankings'] })

    return NextResponse.json({
      ok: true,
      views: ['mv_hourly_prices', 'mv_daily_rankings'],
      duration,
    })
  } catch (err: unknown) {
    logger.error('Refresh views failed', { error: (err instanceof Error ? err.message : String(err)) })
    await plog.error(err)
    return NextResponse.json({ error: (err instanceof Error ? err.message : String(err)) }, { status: 500 })
  }
}
