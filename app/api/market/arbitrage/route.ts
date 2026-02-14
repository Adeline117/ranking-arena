import { NextResponse } from 'next/server'
import { detectArbitrageOpportunities } from '@/lib/utils/arbitrage'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:arbitrage')

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const opportunities = await detectArbitrageOpportunities()
    const response = NextResponse.json({ ok: true, opportunities, ts: Date.now() })
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60')
    return response
  } catch (err) {
    log.error('Arbitrage detection failed', err)
    return NextResponse.json({ ok: false, opportunities: [], error: 'Arbitrage detection failed' }, { status: 500 })
  }
}
