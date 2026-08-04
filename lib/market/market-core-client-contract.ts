import { z } from 'zod'
import { fetchMarketJson, type MarketJsonResponse } from './market-fetch'

export const MARKET_DEFAULT_PAIR_SYMBOLS = [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'ARB-USD',
  'BNB-USD',
  'XRP-USD',
  'ADA-USD',
  'DOGE-USD',
  'AVAX-USD',
  'LINK-USD',
  'MATIC-USD',
  'DOT-USD',
  'UNI-USD',
  'ATOM-USD',
  'FIL-USD',
  'APT-USD',
  'OP-USD',
  'SUI-USD',
  'NEAR-USD',
  'PEPE-USD',
  'WIF-USD',
  'SHIB-USD',
  'TRX-USD',
  'RENDER-USD',
  'INJ-USD',
] as const

const MarketCoreRowSchema = z
  .object({
    symbol: z.string().min(1),
    price: z.string().min(1),
    changePct: z.string().regex(/^[+-]\d+\.\d{2}%$/),
    direction: z.enum(['up', 'down']),
  })
  .strict()

const MarketCoreResponseSchema = z
  .object({
    rows: z.array(MarketCoreRowSchema).min(1).max(MARKET_DEFAULT_PAIR_SYMBOLS.length),
    source: z.enum(['coingecko', 'coinbase', 'binance']),
    cached: z.boolean(),
    stale: z.boolean(),
    requestedPairs: z.array(z.string().min(1)).min(1).max(MARKET_DEFAULT_PAIR_SYMBOLS.length),
    expectedCount: z.number().int().positive().max(MARKET_DEFAULT_PAIR_SYMBOLS.length),
    foundCount: z.number().int().positive().max(MARKET_DEFAULT_PAIR_SYMBOLS.length),
    missingPairs: z.array(z.string().min(1)).max(MARKET_DEFAULT_PAIR_SYMBOLS.length),
    partial: z.boolean(),
    collectedAt: z.string().datetime(),
  })
  .strict()

export type MarketCoreRow = z.infer<typeof MarketCoreRowSchema>
export type MarketCoreSnapshot = z.infer<typeof MarketCoreResponseSchema>

const MarketExchangeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    year_established: z.number().int().positive().nullable(),
    country: z.string().min(1).nullable(),
    image: z.string(),
    trust_score: z.number().finite().nonnegative().nullable(),
    trust_score_rank: z.number().int().positive().nullable(),
    trade_volume_24h_btc: z.number().finite().positive(),
  })
  .strict()

export interface MarketExchangeSnapshot {
  items: z.infer<typeof MarketExchangeSchema>[]
  partial: boolean
}

export function readMarketExchangesResponse(value: unknown): MarketExchangeSnapshot {
  const items = z.array(MarketExchangeSchema).min(1).max(10).parse(value)
  const identities = items.map((item) => item.id)
  if (new Set(identities).size !== identities.length) {
    throw new Error('Market exchanges response contains duplicate identities')
  }
  return { items: items.slice(0, 5), partial: items.length < 5 }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function parsePositivePrice(value: string): number {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return Number.NaN
  return Number(value.replaceAll(',', ''))
}

function parseChange(value: string): number {
  return Number(value.slice(0, -1))
}

export function readMarketCoreResponse(
  value: unknown,
  expectedPairs: readonly string[] = MARKET_DEFAULT_PAIR_SYMBOLS
): MarketCoreSnapshot {
  const parsed = MarketCoreResponseSchema.parse(value)
  if (!arraysEqual(parsed.requestedPairs, expectedPairs)) {
    throw new Error('Market response requested-pair receipt does not match the request')
  }
  if (parsed.expectedCount !== expectedPairs.length) {
    throw new Error('Market response expectedCount does not match the request')
  }

  const rowSymbols = parsed.rows.map((row) => row.symbol)
  if (new Set(rowSymbols).size !== rowSymbols.length) {
    throw new Error('Market response contains duplicate symbols')
  }
  if (rowSymbols.some((symbol) => !expectedPairs.includes(symbol))) {
    throw new Error('Market response contains an unrequested symbol')
  }

  for (const row of parsed.rows) {
    const price = parsePositivePrice(row.price)
    const change = parseChange(row.changePct)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) {
      throw new Error(`Market response contains invalid metrics for ${row.symbol}`)
    }
    if ((change >= 0 ? 'up' : 'down') !== row.direction) {
      throw new Error(`Market response direction disagrees with changePct for ${row.symbol}`)
    }
  }

  const expectedMissing = expectedPairs.filter((symbol) => !rowSymbols.includes(symbol))
  if (!arraysEqual(parsed.missingPairs, expectedMissing)) {
    throw new Error('Market response missingPairs does not match returned rows')
  }
  if (parsed.foundCount !== parsed.rows.length) {
    throw new Error('Market response foundCount does not match returned rows')
  }
  if (parsed.partial !== expectedMissing.length > 0) {
    throw new Error('Market response partial flag does not match provider coverage')
  }

  return parsed
}

export function createMarketCoreSnapshot(input: {
  rows: MarketCoreRow[]
  source: MarketCoreSnapshot['source']
  cached: boolean
  stale: boolean
  requestedPairs: readonly string[]
  collectedAt: string
}): MarketCoreSnapshot {
  const rowSymbols = input.rows.map((row) => row.symbol)
  return readMarketCoreResponse(
    {
      ...input,
      requestedPairs: [...input.requestedPairs],
      expectedCount: input.requestedPairs.length,
      foundCount: input.rows.length,
      missingPairs: input.requestedPairs.filter((symbol) => !rowSymbols.includes(symbol)),
      partial: input.rows.length !== input.requestedPairs.length,
    },
    input.requestedPairs
  )
}

export async function fetchMarketCore(
  callerSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<MarketCoreSnapshot> {
  const response: MarketJsonResponse = await fetchMarketJson('/api/market', {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    callerSignal,
    fetchImpl,
  })
  return readMarketCoreResponse(response.value)
}

export async function fetchMarketExchanges(
  callerSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<MarketExchangeSnapshot> {
  const response = await fetchMarketJson('/api/market/exchanges', {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    callerSignal,
    fetchImpl,
  })
  return readMarketExchangesResponse(response.value)
}
