/**
 * GET /api/market/futures
 * Aggregates funding rates + open interest from Supabase.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

interface CachedData { data: unknown; ts: number }
let cache: CachedData | null = null
const CACHE_TTL = 120_000

export async function GET() {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    // Fetch latest funding rates
    const { data: fundingRates } = await supabase
      .from('funding_rates')
      .select('*')
      .order('funding_time', { ascending: false })
      .limit(200)

    // Fetch latest open interest
    const { data: openInterest } = await supabase
      .from('open_interest')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(200)

    // Normalize symbols
    const normalize = (s: string) => s.replace(/-USDT-SWAP|USDT/g, '').toUpperCase()

    // Group by symbol, aggregate across platforms
    const symbolMap: Record<string, any> = {}

    for (const fr of fundingRates || []) {
      const sym = normalize(fr.symbol)
      if (!symbolMap[sym]) {
        symbolMap[sym] = { symbol: sym, contract: `${sym}USDT`, platforms: {} }
      }
      const p = fr.platform
      if (!symbolMap[sym].platforms[p]) symbolMap[sym].platforms[p] = {}
      symbolMap[sym].platforms[p].fundingRate = fr.funding_rate
      symbolMap[sym].platforms[p].fundingTime = fr.funding_time
    }

    for (const oi of openInterest || []) {
      const sym = normalize(oi.symbol)
      if (!symbolMap[sym]) {
        symbolMap[sym] = { symbol: sym, contract: `${sym}USDT`, platforms: {} }
      }
      const p = oi.platform
      if (!symbolMap[sym].platforms[p]) symbolMap[sym].platforms[p] = {}
      symbolMap[sym].platforms[p].openInterest = oi.open_interest_usd
    }

    // Also fetch current prices from CoinGecko for the symbols we have
    const ids = Object.keys(symbolMap).map(s => s.toLowerCase()).join(',')
    const priceMap: Record<string, any> = {}
    try {
      const cgRes = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&sparkline=false&price_change_percentage=24h`,
        { next: { revalidate: 60 } }
      )
      if (cgRes.ok) {
        const cgData: any[] = await cgRes.json()
        for (const c of cgData) {
          priceMap[c.symbol.toUpperCase()] = {
            price: c.current_price,
            change24h: c.price_change_percentage_24h,
            volume24h: c.total_volume,
            image: c.image,
          }
        }
      }
    } catch { /* ignore */ }

    const result = Object.values(symbolMap).map((item: any) => {
      const pg = priceMap[item.symbol] || {}
      // Average funding rate across platforms
      const platforms = Object.entries(item.platforms) as [string, any][]
      const rates = platforms.map(([, v]) => v.fundingRate).filter(Boolean)
      const avgRate = rates.length ? rates.reduce((a: number, b: number) => a + b, 0) / rates.length : null
      const totalOI = platforms.reduce((sum: number, [, v]) => sum + (v.openInterest || 0), 0)

      return {
        symbol: item.symbol,
        contract: item.contract,
        price: pg.price ?? null,
        change24h: pg.change24h ?? null,
        volume24h: pg.volume24h ?? null,
        image: pg.image ?? null,
        fundingRate: avgRate,
        openInterest: totalOI || null,
        predictedFunding: avgRate != null ? avgRate * 0.95 : null, // Simple estimate
        platforms: item.platforms,
      }
    })

    result.sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0))

    cache = { data: result, ts: now }
    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
