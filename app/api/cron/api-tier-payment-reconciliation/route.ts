import type { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { drainApiTierPaymentBackfill } from '@/lib/stripe/api-tier-payment-backfill'
import { drainApiTierReversalActions } from '@/lib/stripe/api-tier-reversal-actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron(
  'api-tier-payment-reconciliation',
  async (_request: NextRequest, { supabase }) => {
    const [reversals, backfill] = await Promise.all([
      drainApiTierReversalActions({ supabase, limit: 25 }),
      drainApiTierPaymentBackfill({ supabase, limit: 1 }),
    ])

    return {
      success: true,
      reversals,
      backfill,
    }
  }
)
