/**
 * GET /api/v2/market-intelligence
 *
 * Market intelligence endpoint providing funding rates, open interest,
 * liquidation data, and market conditions for copy trading analysis.
 *
 * Query params:
 *   symbol: string (default: 'BTC')
 *   platform: string (optional, filter by platform)
 *   lookback_hours: number (default: 24, max: 168)
 *
 * Response includes:
 *   - funding_rates: FundingRateData[]
 *   - open_interest: OpenInterestData[]
 *   - liquidations: LiquidationStats
 *   - market_condition: MarketConditionData
 *   - meta: { symbol, platforms, lookback_hours, updated_at }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 300 // ISR: revalidate every 5 minutes

// ============================================
// Types
// ============================================

interface FundingRateData {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
  annualized_rate: number
}

interface OpenInterestData {
  platform: string
  symbol: string
  open_interest_usd: number
  change_24h_pct: number | null
  timestamp: string
}

interface LiquidationStats {
  total_long_usd: number
  total_short_usd: number
  long_count: number
  short_count: number
  largest_liquidation: {
    platform: string
    side: string
    value_usd: number
    timestamp: string
  } | null
  hourly_breakdown: Array<{
    hour: string
    long_usd: number
    short_usd: number
  }>
}

interface MarketConditionData {
  symbol: string
  condition: 'bull' | 'bear' | 'sideways'
  volatility_regime: 'low' | 'medium' | 'high' | 'extreme'
  trend_strength: number
  price_change_24h_pct: number | null
  rsi_14: number | null
  updated_at: string
}

interface MarketIntelligenceResponse {
  funding_rates: FundingRateData[]
  open_interest: OpenInterestData[]
  liquidations: LiquidationStats
  market_condition: MarketConditionData | null
  meta: {
    symbol: string
    platforms: string[]
    lookback_hours: number
    updated_at: string
  }
}

// ============================================
// Handler
// ============================================

export async function GET(request: NextRequest) {
  try {
  const { searchParams } = new URL(request.url)

  // Parse params
  const symbol = (searchParams.get('symbol') || 'BTC').toUpperCase()
  const platform = searchParams.get('platform')
  const lookbackHours = Math.min(parseInt(searchParams.get('lookback_hours') || '24', 10) || 24, 168)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }
  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  const lookbackTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()

  // ========================================
  // Parallel queries
  // ========================================
  const [
    fundingResult,
    oiResult,
    oiPrevResult,
    liquidationStatsResult,
    largestLiqResult,
    liquidationHourlyResult,
    marketConditionResult,
    benchmarkResult,
  ] = await Promise.all([
    // 1. Latest funding rates per platform
    (() => {
      let q = supabase
        .from('funding_rates')
        .select('platform, symbol, funding_rate, funding_time')
        .ilike('symbol', `%${symbol}%`)
        .gte('funding_time', lookbackTime)
        .order('funding_time', { ascending: false })
        .limit(50)
      if (platform) q = q.eq('platform', platform)
      return q
    })(),

    // 2. Latest open interest
    (() => {
      let q = supabase
        .from('open_interest')
        .select('platform, symbol, open_interest_usd, timestamp')
        .ilike('symbol', `%${symbol}%`)
        .order('timestamp', { ascending: false })
        .limit(20)
      if (platform) q = q.eq('platform', platform)
      return q
    })(),

    // 3. Previous day open interest (for 24h change)
    (() => {
      const prev24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const prev25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      let q = supabase
        .from('open_interest')
        .select('platform, symbol, open_interest_usd')
        .ilike('symbol', `%${symbol}%`)
        .gte('timestamp', prev25h)
        .lte('timestamp', prev24h)
        .limit(20)
      if (platform) q = q.eq('platform', platform)
      return q
    })(),

    // 4. Liquidation aggregates
    (() => {
      let q = supabase
        .from('liquidation_stats')
        .select('long_liquidations_usd, short_liquidations_usd, long_count, short_count')
        .ilike('symbol', `%${symbol}%`)
        .gte('hour_bucket', lookbackTime)
      if (platform) q = q.eq('platform', platform)
      return q
    })(),

    // 5. Largest liquidation
    (() => {
      let q = supabase
        .from('liquidations')
        .select('platform, side, value_usd, timestamp')
        .ilike('symbol', `%${symbol}%`)
        .gte('timestamp', lookbackTime)
        .order('value_usd', { ascending: false })
        .limit(1)
      if (platform) q = q.eq('platform', platform)
      return q
    })(),

    // 6. Hourly liquidation breakdown
    (() => {
      let q = supabase
        .from('liquidation_stats')
        .select('hour_bucket, long_liquidations_usd, short_liquidations_usd')
        .ilike('symbol', `%${symbol}%`)
        .gte('hour_bucket', lookbackTime)
        .order('hour_bucket', { ascending: true })
      if (platform) q = q.eq('platform', platform)
      return q
    })(),

    // 7. Market condition
    supabase
      .from('market_conditions')
      .select('*')
      .eq('symbol', symbol)
      .order('date', { ascending: false })
      .limit(1),

    // 8. Latest price data
    supabase
      .from('market_benchmarks')
      .select('close_price, daily_return_pct, date')
      .eq('symbol', symbol)
      .order('date', { ascending: false })
      .limit(2),
  ])

  // ========================================
  // Process funding rates
  // ========================================
  const platformLatestFunding = new Map<string, FundingRateData>()

  if (fundingResult.data) {
    for (const f of fundingResult.data) {
      const key = f.platform
      if (!platformLatestFunding.has(key)) {
        // Annualize: funding_rate * 3 (8h periods) * 365
        const annualized = f.funding_rate * 3 * 365 * 100
        platformLatestFunding.set(key, {
          platform: f.platform,
          symbol: f.symbol,
          funding_rate: f.funding_rate,
          funding_time: f.funding_time,
          annualized_rate: Math.round(annualized * 100) / 100,
        })
      }
    }
  }
  const fundingRates = Array.from(platformLatestFunding.values())

  // ========================================
  // Process open interest
  // ========================================
  const platformLatestOI = new Map<string, OpenInterestData>()
  const platformPrevOI = new Map<string, number>()

  if (oiPrevResult.data) {
    for (const o of oiPrevResult.data) {
      if (!platformPrevOI.has(o.platform)) {
        platformPrevOI.set(o.platform, parseFloat(o.open_interest_usd))
      }
    }
  }

  if (oiResult.data) {
    for (const o of oiResult.data) {
      if (!platformLatestOI.has(o.platform)) {
        const currentOI = parseFloat(o.open_interest_usd)
        const prevOI = platformPrevOI.get(o.platform)
        const change24h = prevOI ? ((currentOI - prevOI) / prevOI) * 100 : null

        platformLatestOI.set(o.platform, {
          platform: o.platform,
          symbol: o.symbol,
          open_interest_usd: currentOI,
          change_24h_pct: change24h ? Math.round(change24h * 100) / 100 : null,
          timestamp: o.timestamp,
        })
      }
    }
  }
  const openInterest = Array.from(platformLatestOI.values())

  // ========================================
  // Process liquidations
  // ========================================
  let totalLongUsd = 0
  let totalShortUsd = 0
  let longCount = 0
  let shortCount = 0

  if (liquidationStatsResult.data) {
    for (const s of liquidationStatsResult.data) {
      totalLongUsd += parseFloat(s.long_liquidations_usd || '0')
      totalShortUsd += parseFloat(s.short_liquidations_usd || '0')
      longCount += s.long_count || 0
      shortCount += s.short_count || 0
    }
  }

  const largestLiq = largestLiqResult.data?.[0]
    ? {
        platform: largestLiqResult.data[0].platform,
        side: largestLiqResult.data[0].side,
        value_usd: parseFloat(largestLiqResult.data[0].value_usd),
        timestamp: largestLiqResult.data[0].timestamp,
      }
    : null

  const hourlyBreakdown = (liquidationHourlyResult.data || []).map(h => ({
    hour: h.hour_bucket,
    long_usd: parseFloat(h.long_liquidations_usd || '0'),
    short_usd: parseFloat(h.short_liquidations_usd || '0'),
  }))

  const liquidations: LiquidationStats = {
    total_long_usd: Math.round(totalLongUsd),
    total_short_usd: Math.round(totalShortUsd),
    long_count: longCount,
    short_count: shortCount,
    largest_liquidation: largestLiq,
    hourly_breakdown: hourlyBreakdown,
  }

  // ========================================
  // Process market condition
  // ========================================
  let marketCondition: MarketConditionData | null = null
  const mcData = marketConditionResult.data?.[0]
  const priceData = benchmarkResult.data

  if (mcData) {
    const priceChange = priceData && priceData.length >= 2
      ? ((parseFloat(priceData[0].close_price) - parseFloat(priceData[1].close_price)) /
         parseFloat(priceData[1].close_price)) * 100
      : priceData?.[0]?.daily_return_pct || null

    marketCondition = {
      symbol,
      condition: mcData.condition as 'bull' | 'bear' | 'sideways',
      volatility_regime: mcData.volatility_regime as 'low' | 'medium' | 'high' | 'extreme',
      trend_strength: mcData.trend_strength ? parseFloat(mcData.trend_strength) : 0,
      price_change_24h_pct: priceChange ? Math.round(priceChange * 100) / 100 : null,
      rsi_14: mcData.rsi_14 ? parseFloat(mcData.rsi_14) : null,
      updated_at: mcData.created_at,
    }
  }

  // ========================================
  // Build response
  // ========================================
  const platforms = [...new Set([
    ...fundingRates.map(f => f.platform),
    ...openInterest.map(o => o.platform),
  ])]

  const response: MarketIntelligenceResponse = {
    funding_rates: fundingRates,
    open_interest: openInterest,
    liquidations,
    market_condition: marketCondition,
    meta: {
      symbol,
      platforms,
      lookback_hours: lookbackHours,
      updated_at: new Date().toISOString(),
    },
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  })
  } catch (error) {
    console.error('[v2/market-intelligence] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch market intelligence' }, { status: 500 })
  }
}
