/**
 * /api/report — RETIRED
 *
 * User report submission is exclusively handled by /api/reports and its
 * canonical submit_content_report RPC. This endpoint authenticates only to
 * preserve the normal 401 boundary; it performs no reads, writes, or
 * moderation side effects.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      success: false,
      error: 'The legacy report endpoint has been retired.',
      code: 'REPORT_ENDPOINT_RETIRED',
      successor: '/api/reports',
    },
    {
      status: 410,
      headers: {
        ...NO_STORE_HEADERS,
        Deprecation: 'true',
        Link: '</api/reports>; rel="successor-version"',
      },
    }
  )
}
