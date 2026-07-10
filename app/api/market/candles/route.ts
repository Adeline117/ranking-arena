import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { convertTimeframe, TIMEFRAME_SECONDS, type Timeframe } from '@/lib/utils/candlestick'
import { getOrSetWithLock } from '@/lib/cache'
import { logger } from '@/lib/utils/logger'

const VALID_TIMEFRAMES = Object.keys(TIMEFRAME_SECONDS) as Timeframe[]

// Thrown inside the cache fetcher so an unsupported exchange still yields a 400
// (not a generic 500) after unwrapping from getOrSetWithLock.
class UnsupportedExchangeError extends Error {
  constructor(public exchangeId: string) {
    super(`Unsupported exchange: ${exchangeId}`)
  }
}

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
      { status: 400 }
    )
  }

  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl

    // Shared (Redis) cache with a lock so concurrent misses for the same
    // (symbol, timeframe, exchange) collapse into a single heavy ccxt call —
    // every distinct-key miss otherwise dynamically imports ccxt + fetchOHLCV(500).
    const candles = await getOrSetWithLock(
      `market:candles:${exchangeId}:${symbol}:${timeframe}`,
      async () => {
        // Dynamic import to avoid bundling ccxt (huge) at build time
        const ccxt = await import('ccxt')

        if (!(exchangeId in ccxt.default)) {
          throw new UnsupportedExchangeError(exchangeId)
        }

        const ExchangeClass = (ccxt.default as Record<string, unknown>)[
          exchangeId
        ] as new () => InstanceType<typeof ccxt.default.Exchange>
        const exchange = new ExchangeClass()

        const fetchTimeframe = exchange.timeframes?.['1m'] ? '1m' : timeframe
        const rawCandles = await exchange.fetchOHLCV(symbol, fetchTimeframe, undefined, 500)

        return convertTimeframe(
          rawCandles as [number, number, number, number, number, number][],
          fetchTimeframe as Timeframe,
          timeframe
        )
      },
      { ttl: 60 }
    )

    const response = NextResponse.json({ symbol, timeframe, exchange: exchangeId, candles })
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return response
  } catch (error) {
    if (error instanceof UnsupportedExchangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    logger.error(
      '[market/candles] Failed:',
      error instanceof Error ? error : new Error(String(error))
    )
    return NextResponse.json({ error: 'Failed to fetch candle data' }, { status: 500 })
  }
}
