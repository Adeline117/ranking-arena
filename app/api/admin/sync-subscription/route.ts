/**
 * Retired direct administrator subscription-reconciliation command.
 *
 * Preserve the established verifyAdminAuth credential contract before
 * revealing the V1 hold: service CRON bearer, x-admin-token, or an allowed
 * active administrator JWT. After authentication, this source path must not
 * parse the endpoint query, rate-limit, initialize Stripe/Supabase/logging,
 * or mutate a subscription projection.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import {
  V1_BILLING_RECONCILIATION_NO_STORE_HEADERS,
  V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY,
} from '@/lib/stripe/v1-billing-reconciliation-publication'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_BILLING_RECONCILIATION_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_BILLING_RECONCILIATION_NO_STORE_HEADERS,
  })
}
