import { NextResponse } from 'next/server'
import { detectArbitrageOpportunities } from '@/lib/utils/arbitrage'
import { createLogger } from '@/lib/utils/logger'
import { getOrSetWithLock } from '@/lib/cache'

const log = createLogger('api:arbitrage')

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const result = await getOrSetWithLock(
      'api:market:arbitrage',
      async () => {
        const opportunities = await detectArbitrageOpportunities()
        return { ok: true, opportunities, ts: Date.now() }
      },
      { ttl: 30, lockTtl: 15 }
    )
    const response = NextResponse.json(result)
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60')
    return response
  } catch (err) {
    log.error('Arbitrage detection failed', err)
    return NextResponse.json({ ok: false, opportunities: [], error: 'Arbitrage detection failed' }, { status: 500 })
  }
}
