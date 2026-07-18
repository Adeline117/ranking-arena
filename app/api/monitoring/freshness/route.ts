/**
 * Deprecated compatibility route.
 *
 * The former implementation queried an obsolete trader_snapshots RPC and
 * reported historical row coverage as current serving health. It is retired
 * instead of silently translating callers into a different JSON schema.
 */

import { NextResponse } from 'next/server'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SUCCESSOR_PATH = '/api/admin/data-freshness'
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  const response = NextResponse.json(
    {
      error: 'The legacy freshness endpoint has been retired.',
      code: 'MONITORING_FRESHNESS_ENDPOINT_RETIRED',
      successor: SUCCESSOR_PATH,
    },
    { status: 410, headers: NO_STORE_HEADERS }
  )
  response.headers.set('Deprecation', 'true')
  response.headers.set('Link', `<${SUCCESSOR_PATH}>; rel="successor-version"`)
  return response
}
