/**
 * Dedicated GMX enrichment endpoint
 *
 * GMX requires >360s to enrich 500 traders for 90D period,
 * so it's split from batch-enrich to avoid timeout issues.
 *
 * Runs all periods (90D, 30D, 7D) sequentially.
 *
 * TEMPORARILY DISABLED 2026-03-16:
 * - Intermittent 50% failure rate (was working earlier, now failing)
 * - Likely GraphQL API instability
 * - Re-enable after investigating root cause
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 600 // Vercel Pro max: 10 minutes

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // TEMPORARY: Return success without running enrichment
  const plog = await PipelineLogger.start('enrich-gmx-all')
  await plog.success(0, {
    reason: 'temporarily disabled due to intermittent failures',
    failureRate: '~50%',
    note: 'Will re-enable after GraphQL endpoint stability investigation',
  })

  return NextResponse.json({
    ok: true,
    platform: 'gmx',
    disabled: true,
    reason: 'Temporarily disabled - intermittent 50% failure rate',
  })
}
