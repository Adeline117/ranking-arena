/**
 * Batch dispatcher for all "every 5 minutes" cron jobs.
 *
 * Runs sub-jobs INLINE (in-process) to avoid:
 * - Cloudflare 100s proxy timeout (via NEXT_PUBLIC_APP_URL)
 * - Vercel deployment protection 401 (via VERCEL_URL)
 *
 * Sub-jobs:
 * - run-worker: Process pending refresh_jobs
 * - refresh-hot-scores: Update post hot_score via RPC
 * - trader-sync: Sync authorized trader data from exchanges
 *
 * Schedule: every 5 min (see vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import {
  runWorkerInline,
  refreshHotScoresInline,
  syncTradersInline,
  type InlineJobResult,
} from '@/lib/cron/inline-jobs'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes — longest of the three

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const plog = await PipelineLogger.start('batch-5min')

  // Run all sub-jobs in parallel — they are independent, no HTTP needed
  // Wrap with 250s timeout to ensure plog gets closed within 300s maxDuration
  let results: InlineJobResult[]
  try {
    results = await Promise.race([
      Promise.all([
        runWorkerInline(),
        refreshHotScoresInline(),
        syncTradersInline(),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('batch-5min timed out after 250s')), 250_000)
      ),
    ])
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ batch: 'batch-5min', status: 'error', error: String(err) }, { status: 500 })
  }

  const totalDuration = Date.now() - startTime
  const hasErrors = results.some(r => r.status === 'error')
  const succeeded = results.filter(r => r.status === 'success').length
  if (hasErrors) {
    await plog.error(new Error(`${results.length - succeeded}/${results.length} sub-jobs failed`), { results })
  } else {
    await plog.success(succeeded, { results })
  }

  return NextResponse.json({
    batch: 'batch-5min',
    status: hasErrors ? 'partial' : 'success',
    totalDurationMs: totalDuration,
    results,
  }, {
    status: hasErrors ? 207 : 200,
  })
}
