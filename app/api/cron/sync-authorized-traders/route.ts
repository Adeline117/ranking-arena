/**
 * Cron: Sync authorized trader data
 * Schedule: Every 5 minutes
 *
 * Calls /api/trader/sync with no body (cron mode)
 * which syncs all active authorizations respecting sync_frequency.
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

const logger = createLogger('cron-sync-authorized')

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = await PipelineLogger.start('sync-authorized-traders')

  try {
    // Call the sync endpoint in cron mode (no body filters = sync all due)
    const baseUrl = request.nextUrl.origin
    const response = await fetch(`${baseUrl}/api/trader/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CRON_SECRET}`,
      },
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Sync endpoint returned ${response.status}: ${text}`)
    }

    const result = await response.json()
    logger.info('[Cron] Authorized trader sync completed', result)

    await log.success(result.synced || 0)

    return NextResponse.json({
      success: true,
      synced: result.synced,
      errors: result.errors,
      total: result.total,
    })
  } catch (error) {
    logger.error('[Cron] Authorized trader sync failed', {}, error as Error)
    await log.error(error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
