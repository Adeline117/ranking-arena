import { NextResponse } from 'next/server'
import { detectArbitrageOpportunities } from '@/lib/utils/arbitrage'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:arbitrage')

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const opportunities = await detectArbitrageOpportunities()
    return NextResponse.json({ ok: true, opportunities, ts: Date.now() })
  } catch (err) {
    log.error('套利检测失败', err)
    return NextResponse.json({ ok: false, opportunities: [], error: '套利检测失败' }, { status: 500 })
  }
}
