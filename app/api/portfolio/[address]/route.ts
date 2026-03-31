/**
 * GET /api/portfolio/[address]
 * Returns cross-chain EVM portfolio for the given address.
 * Cached in Redis for 30 seconds.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPortfolio } from '@/lib/chains/evm-adapter'
import * as cache from '@/lib/cache'

export const dynamic = 'force-dynamic'

function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params

    if (!isValidEvmAddress(address)) {
      return NextResponse.json(
        { error: 'Invalid EVM address' },
        { status: 400 }
      )
    }

    const cacheKey = `portfolio:evm:${address.toLowerCase()}`

    // Try cache first
    const cached = await cache.get<ReturnType<typeof getPortfolio> extends Promise<infer T> ? T : never>(cacheKey)
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'X-Cache': 'HIT' },
      })
    }

    // Fetch fresh data
    const portfolio = await getPortfolio(address)

    // Cache for 30 seconds
    await cache.set(cacheKey, portfolio, { ttl: 30 })

    return NextResponse.json(portfolio, {
      headers: { 'X-Cache': 'MISS' },
    })
  } catch (error) {
    console.error('[portfolio] Error:', error instanceof Error ? error.message : String(error))
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
