/**
 * GET /api/feed
 *
 * Proxy to /api/feed/activities for convenience.
 * Returns public feed of auto-generated trader activity events.
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Forward to the activities sub-route
  const url = new URL(request.url)
  const params = url.searchParams.toString()
  const activitiesUrl = new URL(`/api/feed/activities${params ? `?${params}` : ''}`, url.origin)

  const response = await fetch(activitiesUrl.toString(), {
    headers: Object.fromEntries(request.headers.entries()),
  })

  const data = await response.json()
  return NextResponse.json(data, {
    status: response.status,
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
  })
}
