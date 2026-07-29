/**
 * POST /api/admin/sync-subscription?userId=xxx
 *
 * Recomputes Pro projections from the durable entitlement ledger. The
 * service-role reconciliation RPC is the only writer and includes official
 * group convergence in its transactional authority boundary.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { logger } from '@/lib/logger'
import { reconcileAllDueProEntitlementProjections } from '@/lib/stripe/projection-reconciliation'

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, {
    ...RateLimitPresets.sensitive,
    prefix: 'admin-sync-subscription',
    failClose: true,
  })
  if (rateLimitResponse) return rateLimitResponse

  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = new URL(request.url).searchParams.get('userId')
  if (!userId || userId !== userId.toLowerCase() || !UUID_PATTERN.test(userId)) {
    return NextResponse.json({ error: 'Invalid required query param: userId' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  try {
    const { data: before, error: beforeError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle()
    if (beforeError) {
      throw new Error(`Failed to verify projection subject: ${beforeError.message}`)
    }
    if (!before) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const reconciliation = await reconcileAllDueProEntitlementProjections(supabase)

    const { data: projection, error: projectionError } = await supabase
      .from('user_profiles')
      .select(
        'id, is_pro, subscription_tier, pro_plan, pro_expires_at, stripe_customer_id, stripe_subscription_id'
      )
      .eq('id', userId)
      .maybeSingle()
    if (projectionError || !projection) {
      throw new Error(
        `Failed to read reconciled projection: ${projectionError?.message || 'subject disappeared'}`
      )
    }

    logger.info('Admin reconciled Pro projection through entitlement authority', {
      userId,
      reconciliation,
      isPro: projection.is_pro,
    })
    return NextResponse.json({
      success: true,
      action: 'reconciled_authority',
      projection,
      reconciliation,
    })
  } catch (error) {
    logger.apiError('/api/admin/sync-subscription', error, { userId })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
