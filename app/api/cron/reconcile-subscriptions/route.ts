/**
 * Cron: atomically reconcile every Pro projection from the durable entitlement
 * ledger. Stripe/network snapshots are not entitlement authority here.
 */

import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { withCron } from '@/lib/api/with-cron'
import { createLogger } from '@/lib/utils/logger'
import { reconcileAllDueProEntitlementProjections } from '@/lib/stripe/projection-reconciliation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('reconcile-subscriptions')

export const GET = withCron(
  'reconcile-subscriptions',
  async (_request: NextRequest, { supabase }) => {
    const sb: SupabaseClient<Database> = supabase
    const result = await reconcileAllDueProEntitlementProjections(sb)
    logger.info('Atomic Pro entitlement projection reconciliation completed', result)
    return {
      count: result.processedCount,
      reconciled: result.processedCount,
      authorities: result.authorityCount,
      pages: result.pages,
      errors: [],
    }
  },
  { safetyTimeoutMs: 55_000 }
)
