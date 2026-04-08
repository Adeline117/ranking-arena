/**
 * Debug endpoint — test new Bybit endpoints from Vercel to find what's not WAF-blocked.
 */
import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const maxDuration = 30

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.bybit.com/copyTrade/',
  'Origin': 'https://www.bybit.com',
}

async function testEndpoint(url: string): Promise<{ url: string; status: number | string; snippet: string; time_ms: number }> {
  const start = Date.now()
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) })
    const text = await res.text()
    return { url, status: res.status, snippet: text.slice(0, 300), time_ms: Date.now() - start }
  } catch (err) {
    return { url, status: 'ERROR', snippet: err instanceof Error ? err.message : String(err), time_ms: Date.now() - start }
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const endTimeE3 = Math.floor(Date.now() / 1000) * 1000

  const urls = [
    `https://api2.bybit.com/fapi/beehive/public/v1/common/leaderboard-info`,
    `https://api2.bybit.com/fapi/beehive/public/v1/common/trader-leaderboard?rankingForm=RANKING_FORM_TRADERS_PNL&period=PERIOD_30D&endTimeE3=${endTimeE3}`,
    `https://api2.bybit.com/fapi/beehive/public/v1/common/trader-leaderboard?rankingForm=RANKING_FORM_TRADERS_ROI&period=PERIOD_30D&endTimeE3=${endTimeE3}`,
    `https://api2.bybit.com/fapi/beehive/public/v1/common/symbol-list`,
    `https://api2.bybit.com/fapi/beehive/public/v1/common/tags`,
  ]

  const results = []
  for (const u of urls) {
    results.push(await testEndpoint(u))
    await new Promise(r => setTimeout(r, 200))
  }

  return NextResponse.json({ results })
}
