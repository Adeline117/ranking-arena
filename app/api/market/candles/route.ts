import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { convertTimeframe, TIMEFRAME_SECONDS, type Timeframe } from '@/lib/utils/candlestick'

const VALID_TIMEFRAMES = Object.keys(TIMEFRAME_SECONDS) as Timeframe[]

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const symbol = searchParams.get('symbol')
  const timeframe = searchParams.get('timeframe') as Timeframe | null
  const exchangeId = searchParams.get('exchange') || 'binance'

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 })
  }

  if (!timeframe || !VALID_TIMEFRAMES.includes(timeframe)) {
    return NextResponse.json(
      { error: `timeframe must be one of: ${VALID_TIMEFRAMES.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl
    // Dynamic import to avoid bundling ccxt (huge) at build time
    const ccxt = await import('ccxt')
    
    if (!(exchangeId in ccxt.default)) {
      return NextResponse.json({ error: `Unsupported exchange: ${exchangeId}` }, { status: 400 })
    }

     
    const ExchangeClass = (ccxt.default as Record<string, unknown>)[exchangeId] as new () => InstanceType<typeof ccxt.default.Exchange>
    const exchange = new ExchangeClass()

    const fetchTimeframe = exchange.timeframes?.['1m'] ? '1m' : timeframe
    const rawCandles = await exchange.fetchOHLCV(symbol, fetchTimeframe, undefined, 500)

    const candles = convertTimeframe(
      rawCandles as [number, number, number, number, number, number][],
      fetchTimeframe as Timeframe,
      timeframe,
    )

    const response = NextResponse.json({ symbol, timeframe, exchange: exchangeId, candles })
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return response
  } catch (error) { console.error('[market] Failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Failed to fetch candle data' }, { status: 500 })
  }
}
