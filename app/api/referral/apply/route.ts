/**
 * V1 referral-attribution hold.
 *
 * Authenticate the caller before revealing the hold, then return without
 * parsing a body, applying a rate limit, or performing endpoint-specific
 * referral reads or writes. Reopening this endpoint needs a separately
 * reviewed publication contract.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import {
  V1_REFERRAL_PROGRAM_NO_STORE_HEADERS,
  V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY,
} from '@/lib/referral/v1-publication'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: NextRequest): Promise<NextResponse> {
  // getAuthUser performs the required token and active-account verification.
  // It is the sole unavoidable authentication boundary; keep every endpoint
  // concern after this hold out of the retired route.
  const user = await getAuthUser(request).catch(() => null)

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_REFERRAL_PROGRAM_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_REFERRAL_PROGRAM_NO_STORE_HEADERS,
  })
}
