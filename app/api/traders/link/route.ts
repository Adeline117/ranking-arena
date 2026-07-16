/**
 * /api/traders/link — RETIRED
 *
 * This legacy endpoint wrote unreviewed identities to `trader_links` after
 * checking only that the user had some connection on the same exchange. It
 * never proved that the connection UID matched the requested trader. The
 * canonical claim and linked-account APIs enforce exact ownership and atomic
 * activation, so every legacy method is permanently gone.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

async function retiredTraderLink(request: NextRequest) {
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
      error: 'The legacy trader-link endpoint has been retired.',
      code: 'TRADER_LINK_ENDPOINT_RETIRED',
      replacements: {
        claim: '/api/traders/claim',
        manage: '/api/traders/linked',
      },
    },
    {
      status: 410,
      headers: {
        ...NO_STORE_HEADERS,
        Deprecation: 'true',
        Link: '</api/traders/claim>; rel="successor-version", </api/traders/linked>; rel="alternate"',
      },
    }
  )
}

export const POST = retiredTraderLink
export const GET = retiredTraderLink
export const DELETE = retiredTraderLink
