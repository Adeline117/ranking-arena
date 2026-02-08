/**
 * DefiLlama API client with in-memory caching
 * Source: https://defillama.com/docs/api
 */

// --- Types ---

export interface Protocol {
  id: string
  name: string
  symbol: string
  tvl: number
  change_1d: number | null
  change_7d: number | null
  category: string
  chains: string[]
  logo: string
}

export interface Chain {
  name: string
  tvl: number
  tokenSymbol?: string
}

export interface YieldPool {
  pool: string
  chain: string
  project: string
  symbol: string
  tvlUsd: number
  apy: number
  apyBase: number | null
  apyReward: number | null
}

export interface Stablecoin {
  id: string
  name: string
  symbol: string
  pegMechanism: string
  circulating: number
  price: number
}

export interface DexVolume {
  name: string
  totalVolume24h: number
  change_1d: number | null
}

export interface DefiOverview {
  totalTVL: number
  tvlChange24h: number
  topProtocols: Protocol[]
  chains: Chain[]
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

// --- API functions ---

const BASE = 'https://api.llama.fi'
const YIELDS_BASE = 'https://yields.llama.fi'

export async function fetchTVL(): Promise<number> {
  return cachedFetch('tvl', async () => {
    const res = await fetch(`${BASE}/v2/historicalChainTvl`)
    if (!res.ok) throw new Error(`DefiLlama TVL error: ${res.status}`)
    const data: Array<{ date: number; tvl: number }> = await res.json()
    return data[data.length - 1]?.tvl ?? 0
  })
}

export async function fetchProtocols(limit = 100): Promise<Protocol[]> {
  return cachedFetch(`protocols:${limit}`, async () => {
    const res = await fetch(`${BASE}/protocols`)
    if (!res.ok) throw new Error(`DefiLlama protocols error: ${res.status}`)
    const data: Array<Record<string, unknown>> = await res.json()
    return data
      .sort((a, b) => ((b.tvl as number) || 0) - ((a.tvl as number) || 0))
      .slice(0, limit)
      .map((p) => ({
        id: String(p.id ?? p.slug ?? ''),
        name: String(p.name ?? ''),
        symbol: String(p.symbol ?? ''),
        tvl: (p.tvl as number) || 0,
        change_1d: (p.change_1d as number) ?? null,
        change_7d: (p.change_7d as number) ?? null,
        category: String(p.category ?? ''),
        chains: (p.chains as string[]) || [],
        logo: String(p.logo ?? ''),
      }))
  })
}

export async function fetchChainTVL(chain?: string): Promise<Chain[]> {
  return cachedFetch(`chains:${chain ?? 'all'}`, async () => {
    if (chain) {
      const res = await fetch(`${BASE}/v2/historicalChainTvl/${encodeURIComponent(chain)}`)
      if (!res.ok) throw new Error(`DefiLlama chain TVL error: ${res.status}`)
      const data: Array<{ date: number; tvl: number }> = await res.json()
      const latest = data[data.length - 1]
      return [{ name: chain, tvl: latest?.tvl ?? 0 }]
    }
    const res = await fetch(`${BASE}/v2/chains`)
    if (!res.ok) throw new Error(`DefiLlama chains error: ${res.status}`)
    const data: Array<{ name: string; tvl: number; tokenSymbol?: string }> = await res.json()
    return data
      .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
      .map((c) => ({ name: c.name, tvl: c.tvl || 0, tokenSymbol: c.tokenSymbol }))
  })
}

export async function fetchYields(limit = 20): Promise<YieldPool[]> {
  return cachedFetch(`yields:${limit}`, async () => {
    const res = await fetch(`${YIELDS_BASE}/pools`)
    if (!res.ok) throw new Error(`DefiLlama yields error: ${res.status}`)
    const json: { data: Array<Record<string, unknown>> } = await res.json()
    return json.data
      .filter((p) => (p.tvlUsd as number) > 0)
      .sort((a, b) => ((b.tvlUsd as number) || 0) - ((a.tvlUsd as number) || 0))
      .slice(0, limit)
      .map((p) => ({
        pool: String(p.pool ?? ''),
        chain: String(p.chain ?? ''),
        project: String(p.project ?? ''),
        symbol: String(p.symbol ?? ''),
        tvlUsd: (p.tvlUsd as number) || 0,
        apy: (p.apy as number) || 0,
        apyBase: (p.apyBase as number) ?? null,
        apyReward: (p.apyReward as number) ?? null,
      }))
  })
}

export async function fetchStablecoins(): Promise<Stablecoin[]> {
  return cachedFetch('stablecoins', async () => {
    const res = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true')
    if (!res.ok) throw new Error(`DefiLlama stablecoins error: ${res.status}`)
    const json: { peggedAssets: Array<Record<string, unknown>> } = await res.json()
    return json.peggedAssets.map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? ''),
      symbol: String(s.symbol ?? ''),
      pegMechanism: String(s.pegMechanism ?? ''),
      circulating: ((s.circulating as Record<string, unknown>)?.peggedUSD as number) || 0,
      price: (s.price as number) || 0,
    }))
  })
}

export async function fetchVolumes(): Promise<{ totalVolume24h: number; protocols: DexVolume[] }> {
  return cachedFetch('volumes', async () => {
    const res = await fetch(`${BASE}/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`)
    if (!res.ok) throw new Error(`DefiLlama volumes error: ${res.status}`)
    const json: {
      totalDataChart?: unknown
      total24h?: number
      protocols?: Array<Record<string, unknown>>
    } = await res.json()
    const protocols = (json.protocols || [])
      .sort((a, b) => ((b.total24h as number) || 0) - ((a.total24h as number) || 0))
      .slice(0, 20)
      .map((p) => ({
        name: String(p.name ?? ''),
        totalVolume24h: (p.total24h as number) || 0,
        change_1d: (p.change_1d as number) ?? null,
      }))
    return {
      totalVolume24h: json.total24h || 0,
      protocols,
    }
  })
}

/** Aggregated DeFi overview for the sidebar */
export async function fetchDefiOverview(): Promise<DefiOverview> {
  const [tvl, protocols, chains] = await Promise.all([
    fetchTVL(),
    fetchProtocols(10),
    fetchChainTVL(),
  ])

  const topProtocol = protocols[0]
  const tvlChange24h = topProtocol?.change_1d ?? 0

  return {
    totalTVL: tvl,
    tvlChange24h,
    topProtocols: protocols.slice(0, 5),
    chains: chains.slice(0, 10),
  }
}
