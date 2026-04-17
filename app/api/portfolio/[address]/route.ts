/**
 * GET /api/portfolio/[address]
 * Returns cross-chain EVM portfolio for the given address.
 * Cached in Redis for 5 minutes.
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { getPortfolio } from '@/lib/chains/evm-adapter'
import * as cache from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:portfolio')

export const dynamic = 'force-dynamic'

function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

/** Extract address from URL path */
function extractAddress(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('portfolio')
  return pathParts[idx + 1]
}

export const GET = withPublic(
  async ({ request }) => {
    const address = extractAddress(request.url)

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

    // Cache for 5 minutes — portfolio only changes when user trades
    await cache.set(cacheKey, portfolio, { ttl: 300 })

    return NextResponse.json(portfolio, {
      headers: { 'X-Cache': 'MISS' },
    })
  },
  { name: 'portfolio/address', rateLimit: 'public' }
)
