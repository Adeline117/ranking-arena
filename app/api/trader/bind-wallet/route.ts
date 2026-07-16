/**
 * /api/trader/bind-wallet — RETIRED
 *
 * This legacy route bypassed the claim review lifecycle and wrote active
 * trader authorizations directly. Wallet-owned trader identities must now go
 * through the canonical claim endpoint and owner approval before activation.
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
      error: 'The legacy wallet-binding endpoint has been retired.',
      code: 'TRADER_BIND_WALLET_ENDPOINT_RETIRED',
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
