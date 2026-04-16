/**
 * Cron: Sync authorized trader data
 * Schedule: Every 5 minutes
 *
 * Calls /api/trader/sync with no body (cron mode)
 * which syncs all active authorizations respecting sync_frequency.
 */

import { NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'

const logger = createLogger('cron-sync-authorized')

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = withCron('sync-authorized-traders', async (request: NextRequest) => {
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

  return {
    count: result.synced || 0,
    synced: result.synced,
    errors: result.errors,
    total: result.total,
  }
})
