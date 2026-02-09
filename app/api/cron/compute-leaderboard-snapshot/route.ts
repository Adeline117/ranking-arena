/**
 * Cron: Compute leaderboard snapshot for O(1) reads
 * Schedule: Every hour at :10 (10 * * * *)
 * Calls compute_leaderboard_snapshot() SQL function
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = createLogger('compute-leaderboard-snapshot')

export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const start = Date.now()

  try {
    const { data, error } = await supabase.rpc('compute_leaderboard_snapshot')

    if (error) {
      logger.error('Failed to compute leaderboard snapshot', { error: error.message })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const duration = Date.now() - start
    const insertedCount = data ?? 0
    logger.info('Leaderboard snapshot computed', { insertedCount, duration })

    return NextResponse.json({
      ok: true,
      insertedCount,
      duration,
    })
  } catch (err: unknown) {
    logger.error('Compute leaderboard snapshot failed', { error: (err instanceof Error ? err.message : String(err)) })
    return NextResponse.json({ error: (err instanceof Error ? err.message : String(err)) }, { status: 500 })
  }
}
