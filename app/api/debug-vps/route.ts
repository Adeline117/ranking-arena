import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const vpsHost = process.env.VPS_SCRAPER_SG || 'http://45.76.152.169:3457'
  const vpsKey = process.env.VPS_PROXY_KEY || ''
  const results: Record<string, unknown> = {}

  // Test 1: Direct to scraper :3457 with key
  try {
    const r1 = await fetch(vpsHost.replace(/:\d+$/, ':3457') + '/health', {
      headers: { 'X-Proxy-Key': vpsKey },
      signal: AbortSignal.timeout(5000),
    })
    results.scraper_with_key = { status: r1.status, headers: Object.fromEntries(r1.headers.entries()), body: await r1.text().catch(() => '') }
  } catch (e) { results.scraper_with_key = { error: (e as Error).message } }

  // Test 2: Direct to scraper :3457 NO key
  try {
    const r2 = await fetch(vpsHost.replace(/:\d+$/, ':3457') + '/health', {
      signal: AbortSignal.timeout(5000),
    })
    results.scraper_no_key = { status: r2.status, body: await r2.text().catch(() => '') }
  } catch (e) { results.scraper_no_key = { error: (e as Error).message } }

  // Test 3: Proxy :3456
  try {
    const r3 = await fetch(vpsHost.replace(/:\d+$/, ':3456') + '/health', {
      headers: { 'X-Proxy-Key': vpsKey },
      signal: AbortSignal.timeout(5000),
    })
    results.proxy_3456 = { status: r3.status, body: await r3.text().catch(() => '') }
  } catch (e) { results.proxy_3456 = { error: (e as Error).message } }

  // Test 4: Plain HTTP to port 80
  try {
    const r4 = await fetch('http://45.76.152.169/', {
      signal: AbortSignal.timeout(3000),
    })
    results.port_80 = { status: r4.status }
  } catch (e) { results.port_80 = { error: (e as Error).message } }

  return NextResponse.json({ region: process.env.VERCEL_REGION, results })
}
