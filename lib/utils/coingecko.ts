/**
 * CoinGecko free API client with in-memory caching
 * Used for sector/category performance and exchange volume data
 */

// --- Types ---

export interface CryptoCategory {
  id: string
  name: string
  market_cap: number
  market_cap_change_24h: number
  volume_24h: number
  top_3_coins: string[]
}

export interface ExchangeInfo {
  id: string
  name: string
  year_established: number | null
  country: string | null
  image: string
  trust_score: number | null
  trust_score_rank: number | null
  trade_volume_24h_btc: number
}

// --- Cache ---

interface CacheEntry<T> {
  data: T
  fetchedAt: number
}

const CACHE_TTL = 30 * 60 * 1000 // 30 minutes
const cache = new Map<string, CacheEntry<unknown>>()

async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) {
    return entry.data
  }
  const data = await fetcher()
  cache.set(key, { data, fetchedAt: Date.now() })
  return data
}

// --- API ---

const BASE = 'https://api.coingecko.com/api/v3'

/**
 * Curated category IDs we care about for crypto sectors.
 * CoinGecko returns 200+ categories; we filter to the most relevant ones.
 */
const SECTOR_IDS = new Set([
  'layer-1',
  'layer-2',
  'decentralized-finance-defi',
  'meme-token',
  'artificial-intelligence',
  'gaming',
  'real-world-assets-rwa',
  'decentralized-exchange-dex-token',
  'liquid-staking-tokens',
  'stablecoins',
])

export async function fetchSectorPerformance(): Promise<CryptoCategory[]> {
  return cachedFetch('sectors', async () => {
    const res = await fetch(`${BASE}/coins/categories`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`CoinGecko categories error: ${res.status}`)
    const data: CryptoCategory[] = await res.json()
    return data
      .filter((c) => SECTOR_IDS.has(c.id))
      .sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0))
  })
}

export async function fetchExchangeVolumes(limit = 10): Promise<ExchangeInfo[]> {
  return cachedFetch(`exchanges:${limit}`, async () => {
    const res = await fetch(`${BASE}/exchanges?per_page=${limit}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`CoinGecko exchanges error: ${res.status}`)
    const data: ExchangeInfo[] = await res.json()
    return data.map((e) => ({
      id: e.id,
      name: e.name,
      year_established: e.year_established,
      country: e.country,
      image: e.image,
      trust_score: e.trust_score,
      trust_score_rank: e.trust_score_rank,
      trade_volume_24h_btc: e.trade_volume_24h_btc || 0,
    }))
  })
}
