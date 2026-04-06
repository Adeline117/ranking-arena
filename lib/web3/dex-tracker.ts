/**
 * DEX Trader Tracker — Query on-chain subgraphs for top traders
 * Supports Uniswap V3 (Ethereum) and PancakeSwap (BSC)
 */

// ── Types ──

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface DexTrader {
  address: string
  totalVolumeUSD: number
  txCount: number
  profitEstimate: number
  chain: 'ethereum' | 'bsc'
  dex: 'uniswap' | 'pancakeswap'
}

// ── Subgraph endpoints ──

// TheGraph hosted service was deprecated mid-2025.
// These now use the decentralized network gateway (requires THEGRAPH_API_KEY).
const THEGRAPH_API_KEY = process.env.THEGRAPH_API_KEY || ''

// Subgraph IDs on TheGraph decentralized network
// Uniswap V3: official deployment per docs.uniswap.org
const UNISWAP_V3_SUBGRAPH_ID = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV'
// PancakeSwap V3 BSC: updated per developer.pancakeswap.finance (old ID was removed)
const PANCAKESWAP_SUBGRAPH_ID = 'Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ'

const THEGRAPH_GATEWAY = 'https://gateway.thegraph.com/api'

export const UNISWAP_V3_SUBGRAPH = THEGRAPH_API_KEY
  ? `${THEGRAPH_GATEWAY}/${THEGRAPH_API_KEY}/subgraphs/id/${UNISWAP_V3_SUBGRAPH_ID}`
  : ''

export const PANCAKESWAP_SUBGRAPH = THEGRAPH_API_KEY
  ? `${THEGRAPH_GATEWAY}/${THEGRAPH_API_KEY}/subgraphs/id/${PANCAKESWAP_SUBGRAPH_ID}`
  : ''

// ── GraphQL helpers ──

async function querySubgraph<T>(url: string, query: string): Promise<T> {
  if (!url) throw new Error('Subgraph URL not configured — THEGRAPH_API_KEY required')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Subgraph error ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data: T; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

// ── Uniswap V3 queries ──

interface _UniswapSwapper {
  id: string
  totalSwappedUSD: string
  txCount: string
}

interface UniswapSwap {
  origin: string
  amountUSD: string
  timestamp: string
}

const TOP_SWAPPERS_QUERY = (first: number, skip: number) => `{
  swaps(first: ${first}, skip: ${skip}, orderBy: amountUSD, orderDirection: desc) {
    origin
    amountUSD
    timestamp
  }
}`

const RECENT_LARGE_SWAPS_QUERY = (minUSD: number, first: number) => `{
  swaps(first: ${first}, orderBy: timestamp, orderDirection: desc, where: { amountUSD_gt: "${minUSD}" }) {
    origin
    amountUSD
    timestamp
  }
}`

/**
 * Aggregate swap data by origin address to derive top traders.
 * Uniswap V3 subgraph doesn't have a native "top swappers" entity,
 * so we fetch large swaps and aggregate client-side.
 */
export async function fetchUniswapTopTraders(
  limit = 100,
  pages = 5,
): Promise<DexTrader[]> {
  const addrMap = new Map<string, { volume: number; count: number }>()

  for (let page = 0; page < pages; page++) {
    try {
      const data = await querySubgraph<{ swaps: UniswapSwap[] }>(
        UNISWAP_V3_SUBGRAPH,
        TOP_SWAPPERS_QUERY(1000, page * 1000),
      )
      for (const s of data.swaps) {
        const addr = s.origin.toLowerCase()
        const prev = addrMap.get(addr) ?? { volume: 0, count: 0 }
        prev.volume += parseFloat(s.amountUSD) || 0
        prev.count += 1
        addrMap.set(addr, prev)
      }
    } catch (_err) {
      // Intentionally swallowed: subgraph pagination limit reached or RPC error, return collected data
      break
    }
  }

  return Array.from(addrMap.entries())
    .map(([address, d]) => ({
      address,
      totalVolumeUSD: d.volume,
      txCount: d.count,
      profitEstimate: 0, // no PnL from swap data alone
      chain: 'ethereum' as const,
      dex: 'uniswap' as const,
    }))
    .sort((a, b) => b.totalVolumeUSD - a.totalVolumeUSD)
    .slice(0, limit)
}

export async function fetchUniswapLargeSwaps(
  minUSD = 100_000,
  first = 100,
): Promise<UniswapSwap[]> {
  const data = await querySubgraph<{ swaps: UniswapSwap[] }>(
    UNISWAP_V3_SUBGRAPH,
    RECENT_LARGE_SWAPS_QUERY(minUSD, first),
  )
  return data.swaps
}

// ── PancakeSwap queries ──

const PANCAKE_TOP_SWAPPERS_QUERY = (first: number, skip: number) => `{
  swaps(first: ${first}, skip: ${skip}, orderBy: amountUSD, orderDirection: desc) {
    origin
    amountUSD
    timestamp
  }
}`

export async function fetchPancakeSwapTopTraders(
  limit = 100,
  pages = 5,
): Promise<DexTrader[]> {
  const addrMap = new Map<string, { volume: number; count: number }>()

  for (let page = 0; page < pages; page++) {
    try {
      const data = await querySubgraph<{ swaps: UniswapSwap[] }>(
        PANCAKESWAP_SUBGRAPH,
        PANCAKE_TOP_SWAPPERS_QUERY(1000, page * 1000),
      )
      for (const s of data.swaps) {
        const addr = s.origin.toLowerCase()
        const prev = addrMap.get(addr) ?? { volume: 0, count: 0 }
        prev.volume += parseFloat(s.amountUSD) || 0
        prev.count += 1
        addrMap.set(addr, prev)
      }
    } catch (_err) {
      // Intentionally swallowed: subgraph pagination limit reached or API error, return collected data
      break
    }
  }

  return Array.from(addrMap.entries())
    .map(([address, d]) => ({
      address,
      totalVolumeUSD: d.volume,
      txCount: d.count,
      profitEstimate: 0,
      chain: 'bsc' as const,
      dex: 'pancakeswap' as const,
    }))
    .sort((a, b) => b.totalVolumeUSD - a.totalVolumeUSD)
    .slice(0, limit)
}

/**
 * Fetch top DEX traders across all supported chains/dexes.
 */
export async function fetchAllDexTraders(limit = 50): Promise<DexTrader[]> {
  const [uniswap, pancake] = await Promise.allSettled([
    fetchUniswapTopTraders(limit),
    fetchPancakeSwapTopTraders(limit),
  ])

  const traders: DexTrader[] = []
  if (uniswap.status === 'fulfilled') traders.push(...uniswap.value)
  if (pancake.status === 'fulfilled') traders.push(...pancake.value)

  return traders.sort((a, b) => b.totalVolumeUSD - a.totalVolumeUSD).slice(0, limit)
}
