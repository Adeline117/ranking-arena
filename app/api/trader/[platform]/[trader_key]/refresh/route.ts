/**
 * Retired legacy refresh-job admission endpoint.
 *
 * Keep authentication before the fixed V1 response, but do not read route
 * parameters or a body, apply a rate limit, create an admin client, or touch
 * the legacy queue. A future publisher needs a separately reviewed contract.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getAuthUser } from '@/lib/api'
import {
  V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS,
  V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE,
} from '@/lib/ingest/v1-legacy-refresh-jobs-publication'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      error: V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE,
      message: 'Legacy trader refresh is temporarily unavailable during V1 verification.',
    },
    { status: 410, headers: V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS }
  )
}
