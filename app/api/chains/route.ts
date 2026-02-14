/**
 * GET /api/chains
 * Returns the list of supported EVM chains.
 */

import { NextResponse } from 'next/server'
import { getChainsPublicInfo } from '@/lib/chains/config'

export const revalidate = 3600

export async function GET() {
  const chains = getChainsPublicInfo()

  return NextResponse.json(
    { chains },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      },
    }
  )
}
