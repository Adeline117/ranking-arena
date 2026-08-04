import { z } from 'zod'
import { fetchMarketJson } from './market-fetch'

export const MARKET_SPOT_REQUESTED_COUNT = 100

const nullableFinite = z.number().finite().nullable()
const nullableNonnegative = z.number().finite().nonnegative().nullable()
const nullablePositive = z.number().finite().positive().nullable()

export const MarketSpotCoinSchema = z
  .object({
    id: z.string().min(1),
    symbol: z.string().regex(/^[A-Z0-9.-]+$/),
    name: z.string().min(1),
    image: z.string().nullable(),
    price: z.number().finite().positive(),
    change1h: nullableFinite,
    change24h: z.number().finite(),
    change7d: nullableFinite,
    high24h: nullablePositive,
    low24h: nullablePositive,
    volume24h: nullableNonnegative,
    marketCap: nullableNonnegative,
    rank: z.number().int().positive().nullable(),
  })
  .strict()

export type MarketSpotCoin = z.infer<typeof MarketSpotCoinSchema>

export type CompleteMarketSpotCoin = MarketSpotCoin & {
  high24h: number
  low24h: number
  volume24h: number
  marketCap: number
  rank: number
}

export type RenderableMarketSpotCoin = MarketSpotCoin & {
  high24h: number
  low24h: number
  rank: number
}

export function isRenderableMarketSpotCoin(coin: MarketSpotCoin): coin is RenderableMarketSpotCoin {
  return coin.high24h !== null && coin.low24h !== null && coin.rank !== null
}

export function isCompleteMarketSpotCoin(coin: MarketSpotCoin): coin is CompleteMarketSpotCoin {
  return (
    coin.high24h !== null &&
    coin.low24h !== null &&
    coin.volume24h !== null &&
    coin.marketCap !== null &&
    coin.rank !== null
  )
}

const MarketSpotSnapshotSchema = z
  .object({
    coins: z.array(MarketSpotCoinSchema).min(1).max(MARKET_SPOT_REQUESTED_COUNT),
    source: z.enum(['coingecko', 'binance']),
    requestedCount: z.literal(MARKET_SPOT_REQUESTED_COUNT),
    providerLimit: z.number().int().positive().max(MARKET_SPOT_REQUESTED_COUNT),
    foundCount: z.number().int().positive().max(MARKET_SPOT_REQUESTED_COUNT),
    completeCount: z.number().int().nonnegative().max(MARKET_SPOT_REQUESTED_COUNT),
    partial: z.boolean(),
    collectedAt: z.string().datetime(),
  })
  .strict()

export type MarketSpotSnapshot = z.infer<typeof MarketSpotSnapshotSchema>

function assertSpotSnapshot(snapshot: MarketSpotSnapshot): MarketSpotSnapshot {
  const identities = snapshot.coins.map((coin) => coin.id)
  const symbols = snapshot.coins.map((coin) => coin.symbol)
  if (new Set(identities).size !== identities.length || new Set(symbols).size !== symbols.length) {
    throw new Error('Market spot response contains duplicate coin identities')
  }
  if (snapshot.foundCount !== snapshot.coins.length) {
    throw new Error('Market spot foundCount does not match returned coins')
  }
  const completeCount = snapshot.coins.filter(isCompleteMarketSpotCoin).length
  if (snapshot.completeCount !== completeCount) {
    throw new Error('Market spot completeCount does not match returned coins')
  }
  const partial =
    snapshot.providerLimit < snapshot.requestedCount ||
    snapshot.foundCount < snapshot.requestedCount ||
    snapshot.completeCount < snapshot.foundCount
  if (snapshot.partial !== partial) {
    throw new Error('Market spot partial flag does not match provider coverage')
  }
  return snapshot
}

export function createMarketSpotSnapshot(input: {
  coins: MarketSpotCoin[]
  source: MarketSpotSnapshot['source']
  providerLimit: number
  collectedAt: string
}): MarketSpotSnapshot {
  return assertSpotSnapshot(
    MarketSpotSnapshotSchema.parse({
      ...input,
      requestedCount: MARKET_SPOT_REQUESTED_COUNT,
      foundCount: input.coins.length,
      completeCount: input.coins.filter(isCompleteMarketSpotCoin).length,
      partial:
        input.providerLimit < MARKET_SPOT_REQUESTED_COUNT ||
        input.coins.length < MARKET_SPOT_REQUESTED_COUNT ||
        input.coins.some((coin) => !isCompleteMarketSpotCoin(coin)),
    })
  )
}

function requiredHeader(headers: Pick<Headers, 'get'>, name: string): string {
  const value = headers.get(name)
  if (!value) throw new Error(`Market spot response is missing ${name}`)
  return value
}

function integerHeader(headers: Pick<Headers, 'get'>, name: string): number {
  const raw = requiredHeader(headers, name)
  if (!/^\d+$/.test(raw)) throw new Error(`Market spot response has invalid ${name}`)
  return Number(raw)
}

export function marketSpotReceiptHeaders(snapshot: MarketSpotSnapshot): Record<string, string> {
  return {
    'X-Market-Source': snapshot.source,
    'X-Market-Requested-Count': String(snapshot.requestedCount),
    'X-Market-Provider-Limit': String(snapshot.providerLimit),
    'X-Market-Found-Count': String(snapshot.foundCount),
    'X-Market-Complete-Count': String(snapshot.completeCount),
    'X-Market-Partial': String(snapshot.partial),
    'X-Market-Collected-At': snapshot.collectedAt,
  }
}

export function readMarketSpotResponse(
  value: unknown,
  headers: Pick<Headers, 'get'>
): MarketSpotSnapshot {
  const coins = z.array(MarketSpotCoinSchema).min(1).max(MARKET_SPOT_REQUESTED_COUNT).parse(value)
  const partialHeader = requiredHeader(headers, 'X-Market-Partial')
  if (partialHeader !== 'true' && partialHeader !== 'false') {
    throw new Error('Market spot response has invalid X-Market-Partial')
  }

  return assertSpotSnapshot(
    MarketSpotSnapshotSchema.parse({
      coins,
      source: requiredHeader(headers, 'X-Market-Source'),
      requestedCount: integerHeader(headers, 'X-Market-Requested-Count'),
      providerLimit: integerHeader(headers, 'X-Market-Provider-Limit'),
      foundCount: integerHeader(headers, 'X-Market-Found-Count'),
      completeCount: integerHeader(headers, 'X-Market-Complete-Count'),
      partial: partialHeader === 'true',
      collectedAt: requiredHeader(headers, 'X-Market-Collected-At'),
    })
  )
}

export async function fetchMarketSpot(
  callerSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<MarketSpotSnapshot> {
  const response = await fetchMarketJson('/api/market/spot', {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    callerSignal,
    fetchImpl,
  })
  return readMarketSpotResponse(response.value, response.headers)
}

const CoinGeckoSpotEntrySchema = z
  .object({
    id: z.string().min(1),
    symbol: z.string().min(1),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
    current_price: z.number().finite().positive(),
    price_change_percentage_1h_in_currency: nullableFinite.optional(),
    price_change_percentage_24h: z.number().finite(),
    price_change_percentage_7d_in_currency: nullableFinite.optional(),
    high_24h: nullablePositive.optional(),
    low_24h: nullablePositive.optional(),
    total_volume: nullableNonnegative.optional(),
    market_cap: nullableNonnegative.optional(),
    market_cap_rank: z.number().int().positive().nullable().optional(),
  })
  .passthrough()

export function readCoinGeckoSpotResponse(
  value: unknown,
  collectedAt: string = new Date().toISOString()
): MarketSpotSnapshot {
  if (!Array.isArray(value) || value.length === 0 || value.length > MARKET_SPOT_REQUESTED_COUNT) {
    throw new Error('CoinGecko spot response has an invalid collection size')
  }

  const coins: MarketSpotCoin[] = []
  const seenIds = new Set<string>()
  const seenSymbols = new Set<string>()
  for (const candidate of value) {
    const parsed = CoinGeckoSpotEntrySchema.safeParse(candidate)
    if (!parsed.success) continue
    const symbol = parsed.data.symbol.toUpperCase()
    if (!/^[A-Z0-9.-]+$/.test(symbol) || seenIds.has(parsed.data.id) || seenSymbols.has(symbol)) {
      continue
    }
    seenIds.add(parsed.data.id)
    seenSymbols.add(symbol)
    coins.push({
      id: parsed.data.id,
      symbol,
      name: parsed.data.name,
      image: parsed.data.image ?? null,
      price: parsed.data.current_price,
      change1h: parsed.data.price_change_percentage_1h_in_currency ?? null,
      change24h: parsed.data.price_change_percentage_24h,
      change7d: parsed.data.price_change_percentage_7d_in_currency ?? null,
      high24h: parsed.data.high_24h ?? null,
      low24h: parsed.data.low_24h ?? null,
      volume24h: parsed.data.total_volume ?? null,
      marketCap: parsed.data.market_cap ?? null,
      rank: parsed.data.market_cap_rank ?? null,
    })
  }

  if (coins.length === 0) {
    throw new Error('CoinGecko spot response contains no usable rows')
  }
  return createMarketSpotSnapshot({
    coins,
    source: 'coingecko',
    providerLimit: MARKET_SPOT_REQUESTED_COUNT,
    collectedAt,
  })
}

export const COINGECKO_SPOT_URL =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h,7d'

export async function fetchCoinGeckoSpot(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000
): Promise<MarketSpotSnapshot> {
  const response = await fetchMarketJson(COINGECKO_SPOT_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    fetchImpl,
    timeoutMs,
  })
  return readCoinGeckoSpotResponse(response.value)
}
