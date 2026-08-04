/**
 * Retired compatibility cron for public first-party trader publication.
 *
 * CEX connections remain account-scoped in V1 and do not prove a public
 * leaderboard identity. Keep the authenticated cron contract as a no-op so an
 * old schedule cannot enqueue broad authorization jobs during rollout.
 */

import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron('sync-authorized-traders', async () => ({
  count: 0,
  queued: 0,
  errors: 0,
  total: 0,
  disabled: true,
  reason: 'CEX account connections do not prove public leaderboard identity in Arena V1',
}))
