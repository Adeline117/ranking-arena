/**
 * Uniswap V3 (Ethereum) — Inline fetcher for Vercel serverless
 * Fetches top traders from Uniswap V3 subgraph via The Graph
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
} from '../shared'
import { UNISWAP_V3_SUBGRAPH } // @ts-expect-error deprecated module
from '../../web3/dex-tracker'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'uniswap'
const TARGET = 200
const PAGES = 5

interface SwapEntry {
  origin: string
  amountUSD: string
  timestamp: string
}

async function fetchSwapsPage(first: number, skip: number): Promise<SwapEntry[]> {
  if (!UNISWAP_V3_SUBGRAPH) {
    return [] // THEGRAPH_API_KEY not configured — skip gracefully
  }
  const query = `{
    swaps(first: ${first}, skip: ${skip}, orderBy: amountUSD, orderDirection: desc) {
      origin
      amountUSD
      timestamp
    }
  }`
  const data = await fetchJson<{ data: { swaps: SwapEntry[] } }>(UNISWAP_V3_SUBGRAPH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { query },
    timeoutMs: 15000,
  })
  return data?.data?.swaps ?? []
}

/**
 * Aggregate swaps by origin address to build trader profiles.
 * Rough PnL estimate: not possible from swap data alone, set to 0.
 */
async function aggregateTraders(): Promise<
  Map<string, { volume: number; count: number }>
> {
  const addrMap = new Map<string, { volume: number; count: number }>()
  for (let page = 0; page < PAGES; page++) {
    try {
      const swaps = await fetchSwapsPage(1000, page * 1000)
      if (!swaps.length) break
      for (const s of swaps) {
        const addr = s.origin.toLowerCase()
        const prev = addrMap.get(addr) ?? { volume: 0, count: 0 }
        prev.volume += parseFloat(s.amountUSD) || 0
        prev.count += 1
        addrMap.set(addr, prev)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] Swap page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }
  return addrMap
}

export const fetchUniswap: (
  supabase: SupabaseClient,
  periods: string[],
) => Promise<FetchResult> = async (supabase, periods) => {
  const start = Date.now()
  const result: FetchResult = {
    source: SOURCE,
    periods: {},
    duration: 0,
  }

  try {
    const addrMap = await aggregateTraders()
    const sorted = Array.from(addrMap.entries())
      .sort((a, b) => b[1].volume - a[1].volume)
      .slice(0, TARGET)

    for (const period of periods) {
      try {
        const traders: TraderData[] = sorted.map(([addr, d], i) => ({
          source: SOURCE,
          source_trader_id: addr,
          handle: addr,
          profile_url: `https://etherscan.io/address/${addr}`,
          season_id: period,
          rank: i + 1,
          roi: null,
          pnl: null, // no PnL from spot swap data
          win_rate: null,
          max_drawdown: null,
          trades_count: d.count,
          arena_score: calculateArenaScore(0, null, null, null, period),
          captured_at: new Date().toISOString(),
        }))

        const upsertResult = await upsertTraders(supabase, traders)
        result.periods[period] = { total: traders.length, saved: upsertResult.saved }
      } catch (err) {
        result.periods[period] = {
          total: 0,
          saved: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  result.duration = Date.now() - start
  return result
}
