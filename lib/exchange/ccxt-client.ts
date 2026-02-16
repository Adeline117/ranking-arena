/**
 * CCXT unified exchange client
 * Wraps ccxt library for standardized market data access across exchanges.
 * Used for: ticker/OHLCV data, trading pair lists, price lookups for PnL calculation.
 * NOT used for: copy trading APIs (ccxt doesn't support those).
 */
import type { Exchange, Ticker, OHLCV } from 'ccxt'

// Lazy-load ccxt to avoid 56MB bundle impact on cold starts
let _ccxt: typeof import('ccxt') | null = null
async function getCcxt() {
  if (!_ccxt) {
    _ccxt = await import('ccxt')
  }
  return _ccxt
}

// All supported exchanges
export const SUPPORTED_EXCHANGES = [
  'binance', 'bybit', 'okx', 'bitget', 'mexc',
  'kucoin', 'gateio', 'htx', 'coinex', 'bingx',
  'phemex', 'xt', 'lbank',
] as const

export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number]

// ccxt class name mapping (some differ from our internal names)
const CCXT_CLASS_MAP: Record<SupportedExchange, string> = {
  binance: 'binance',
  bybit: 'bybit',
  okx: 'okx',
  bitget: 'bitget',
  mexc: 'mexc',
  kucoin: 'kucoin',
  gateio: 'gateio',
  htx: 'htx',
  coinex: 'coinex',
  bingx: 'bingx',
  phemex: 'phemex',
  xt: 'xt',
  lbank: 'lbank',
}

// Singleton cache
const exchangeInstances = new Map<string, Exchange>()

export interface CcxtClientOptions {
  apiKey?: string
  secret?: string
  password?: string
  sandbox?: boolean
  timeout?: number
  rateLimit?: boolean
}

/**
 * Get or create a ccxt exchange instance (cached singleton per exchange+options hash).
 */
export async function getExchange(
  name: SupportedExchange,
  options: CcxtClientOptions = {},
): Promise<Exchange> {
  const cacheKey = `${name}:${options.apiKey ?? 'public'}:${options.sandbox ? 'sandbox' : 'live'}`

  if (exchangeInstances.has(cacheKey)) {
    return exchangeInstances.get(cacheKey)!
  }

  const ccxt = await getCcxt()
  const className = CCXT_CLASS_MAP[name]
  const ExchangeClass = (ccxt as unknown as Record<string, new (config: Record<string, unknown>) => Exchange>)[className]
  if (!ExchangeClass) {
    throw new Error(`ccxt does not support exchange: ${name} (class: ${className})`)
  }

  const instance = new ExchangeClass({
    apiKey: options.apiKey,
    secret: options.secret,
    password: options.password,
    timeout: options.timeout ?? 30000,
    enableRateLimit: options.rateLimit !== false,
    ...(options.sandbox ? { sandbox: true } : {}),
  })

  exchangeInstances.set(cacheKey, instance)
  return instance
}

/**
 * Fetch ticker for a symbol across an exchange.
 */
export async function fetchTicker(
  exchangeName: SupportedExchange,
  symbol: string,
): Promise<Ticker> {
  const exchange = await getExchange(exchangeName)
  return exchange.fetchTicker(symbol)
}

/**
 * Fetch OHLCV candles.
 */
export async function fetchOHLCV(
  exchangeName: SupportedExchange,
  symbol: string,
  timeframe = '1h',
  since?: number,
  limit?: number,
): Promise<OHLCV[]> {
  const exchange = await getExchange(exchangeName)
  return exchange.fetchOHLCV(symbol, timeframe, since, limit)
}

/**
 * Fetch all trading pairs (markets) for an exchange.
 */
export async function fetchMarkets(exchangeName: SupportedExchange) {
  const exchange = await getExchange(exchangeName)
  return exchange.loadMarkets()
}

/**
 * Fetch tickers for multiple symbols. Falls back to sequential fetches if fetchTickers not supported.
 */
export async function fetchTickers(
  exchangeName: SupportedExchange,
  symbols: string[],
): Promise<Record<string, Ticker>> {
  const exchange = await getExchange(exchangeName)
  try {
    return await exchange.fetchTickers(symbols)
  } catch {
    // Fallback: fetch one by one
    const result: Record<string, Ticker> = {}
    for (const symbol of symbols) {
      try {
        result[symbol] = await exchange.fetchTicker(symbol)
      } catch {
        // skip failed symbols
      }
    }
    return result
  }
}

/**
 * Fetch open interest for a symbol (futures/swap markets).
 */
export async function fetchOpenInterest(
  exchangeName: SupportedExchange,
  symbol: string,
) {
  const exchange = await getExchange(exchangeName)
  if (typeof exchange.fetchOpenInterest === 'function') {
    return exchange.fetchOpenInterest(symbol)
  }
  return null
}

/**
 * Clear cached exchange instances (for cleanup/testing).
 */
export function clearExchangeCache(): void {
  exchangeInstances.clear()
}
