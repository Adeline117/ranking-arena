/**
 * V1 referral-program hold.
 *
 * Authenticate before revealing the hold, then avoid request parsing, rate
 * limiting, and endpoint-specific referral reads or writes. Reopening either
 * referral-code endpoint needs a separately reviewed publication contract.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import {
  V1_REFERRAL_PROGRAM_NO_STORE_HEADERS,
  V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY,
} from '@/lib/referral/v1-publication'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function referralProgramHoldResponse(request: NextRequest): Promise<NextResponse> {
  // getAuthUser performs the required token and active-account verification.
  // It is the sole unavoidable authentication boundary for this retired route.
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  return referralProgramHoldResponse(request)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return referralProgramHoldResponse(request)
}
