/**
 * /api/traders/claim/verify-wallet — RETIRED
 *
 * This preflight endpoint consumed the wallet signature replay nonce without
 * creating a claim. Reusing that proof in the canonical claim endpoint then
 * failed as a replay. Wallet proof verification now happens exactly once,
 * inside POST /api/traders/claim before the review submission is created.
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
      error: 'Wallet proof verification now happens inside the trader claim request.',
      code: 'WALLET_VERIFICATION_ENDPOINT_RETIRED',
      replacement: '/api/traders/claim',
    },
    {
      status: 410,
      headers: {
        ...NO_STORE_HEADERS,
        Deprecation: 'true',
        Link: '</api/traders/claim>; rel="successor-version"',
      },
    }
  )
}
