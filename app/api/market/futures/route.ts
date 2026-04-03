/**
 * GET /api/market/futures
 * Aggregates funding rates + open interest from Supabase.
 * Redis-cached for 2 minutes with lock to prevent thundering herd.
 */
import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getOrSetWithLock } from '@/lib/cache'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const result = await getOrSetWithLock(
      'api:market:futures',
      async () => computeFuturesData(),
      { ttl: 120, lockTtl: 10 }
    )

    const response = NextResponse.json(result)
    response.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
    return response
  } catch (e: unknown) {
    return NextResponse.json({ error: 'Failed to fetch futures data' }, { status: 500 })
  }
}

async function computeFuturesData() {
  const supabase = getSupabaseAdmin()

  // Run DB queries in parallel
  const [fundingResult, oiResult] = await Promise.all([
    supabase
      .from('funding_rates')
      .select('symbol, platform, funding_rate, funding_time')
      .order('funding_time', { ascending: false })
      .limit(200),
    supabase
      .from('open_interest')
      .select('symbol, platform, open_interest_usd, timestamp')
      .order('timestamp', { ascending: false })
      .limit(200),
  ])

  const fundingRates = fundingResult.data
  const openInterest = oiResult.data

  // Normalize symbols
  const normalize = (s: string) => s.replace(/-USDT-SWAP|USDT/g, '').toUpperCase()

  // Group by symbol, aggregate across platforms
  const symbolMap: Record<string, { symbol: string; contract: string; platforms: Record<string, { fundingRate?: number; fundingTime?: string; openInterest?: number }> }> = {}

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

  // Fetch prices from CoinGecko
  // CoinGecko uses full names (solana, ethereum) not ticker symbols (SOL, ETH)
  const SYMBOL_TO_CG_ID: Record<string, string> = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
    XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2',
    DOT: 'polkadot', LINK: 'chainlink', MATIC: 'matic-network', UNI: 'uniswap',
    ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', APT: 'aptos',
    NEAR: 'near', ATOM: 'cosmos', FIL: 'filecoin', LTC: 'litecoin',
    TRX: 'tron', TON: 'the-open-network', PEPE: 'pepe', WIF: 'dogwifcoin',
    AAVE: 'aave', MKR: 'maker', RENDER: 'render-token', INJ: 'injective-protocol',
    FET: 'fetch-ai', BONK: 'bonk', WLD: 'worldcoin-wld', JUP: 'jupiter-exchange-solana',
  }
  const symbols = Object.keys(symbolMap)
  const cgIds = symbols.map(s => SYMBOL_TO_CG_ID[s] || s.toLowerCase()).filter(Boolean).join(',')
  const priceMap: Record<string, { price: number; change24h: number; volume24h: number; image: string }> = {}
  try {
    const cgRes = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgIds}&sparkline=false&price_change_percentage=24h`,
      { next: { revalidate: 60 } }
    )
    if (cgRes.ok) {
      const cgData: Array<{ symbol: string; current_price: number; price_change_percentage_24h: number; total_volume: number; image: string }> = await cgRes.json()
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

  const result = Object.values(symbolMap).map((item) => {
    const pg = priceMap[item.symbol] || {} as Partial<typeof priceMap[string]>
    const platforms = Object.entries(item.platforms)
    const rates = platforms.map(([, v]) => v.fundingRate).filter((r): r is number => r != null)
    const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null
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
      predictedFunding: avgRate != null ? avgRate * 0.95 : null,
      platforms: item.platforms,
    }
  })

  result.sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0))
  return result
}
