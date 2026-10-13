/**
 * Retired arbitrary push-sender endpoint.
 *
 * V1 does not publish personalized trader/ranking alert delivery. This route
 * previously allowed an authenticated caller to supply arbitrary push payloads,
 * including retired alert types. It now authenticates before returning a fixed
 * no-store tombstone and never parses a body, reads a role, or contacts a push
 * provider.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import {
  TRADER_ALERTS_NO_STORE_HEADERS,
  TRADER_NOTIFICATION_NOT_PUBLISHED_CODE,
  TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE,
} from '@/lib/alerts/trader-alert-publication'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: NextRequest): Promise<NextResponse> {
  let user: Awaited<ReturnType<typeof getAuthUser>>
  try {
    user = await getAuthUser(request)
  } catch {
    user = null
  }

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      error: 'Retired push sender',
      code: TRADER_NOTIFICATION_NOT_PUBLISHED_CODE,
      message: TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE,
    },
    { status: 410, headers: TRADER_ALERTS_NO_STORE_HEADERS }
  )
}
