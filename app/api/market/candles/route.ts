import { NextRequest, NextResponse } from 'next/server'
import ccxt from 'ccxt'
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
    if (!(exchangeId in ccxt)) {
      return NextResponse.json({ error: `Unsupported exchange: ${exchangeId}` }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ExchangeClass = (ccxt as any)[exchangeId] as new () => InstanceType<typeof ccxt.Exchange>
    const exchange = new ExchangeClass()

    // Fetch in the smallest available timeframe and convert up, or fetch directly
    const fetchTimeframe = exchange.timeframes?.['1m'] ? '1m' : timeframe
    const rawCandles = await exchange.fetchOHLCV(symbol, fetchTimeframe, undefined, 500)

    const candles = convertTimeframe(
      rawCandles as [number, number, number, number, number, number][],
      fetchTimeframe as Timeframe,
      timeframe,
    )

    return NextResponse.json({ symbol, timeframe, exchange: exchangeId, candles })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
