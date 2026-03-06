/**
 * Vertex Protocol (Arbitrum) — Inline fetcher for Vercel serverless
 * 
 * STATUS: Limited - Vertex does not expose a public leaderboard API
 * 
 * Vertex Protocol is an Arbitrum-based perps DEX. Unlike Hyperliquid or GMX,
 * Vertex currently does not have:
 * - Public leaderboard endpoint
 * - Subgraph with trader-level data
 * - Historical PnL aggregation API
 * 
 * The Vertex indexer at archive.prod.vertexprotocol.com only provides
 * market-level data, not trader leaderboards.
 * 
 * WORKAROUND OPTIONS (not implemented):
 * 1. Build custom indexer from on-chain events
 * 2. Partner with Vertex team for API access
 * 3. Use Dune Analytics query (requires API key)
 * 
 * This fetcher returns an informative error until a data source is available.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,

} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'vertex'
const _TARGET = 500

// Known Vertex API endpoints (none currently support leaderboard)
const ENDPOINTS_TRIED = [
  'https://archive.prod.vertexprotocol.com/v1 (indexer - no leaderboard)',
  'https://gateway.prod.vertexprotocol.com/v1/query (gateway - no leaderboard)',
  'https://stats.vertexprotocol.com/api (stats - not available)',
]

// ── Per-period fetch ──

async function fetchPeriod(
  _supabase: SupabaseClient,
  _period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // Return informative error about API limitations
  return {
    total: 0,
    saved: 0,
    error:
      'Vertex Protocol does not expose a public leaderboard API. ' +
      'Tried endpoints: ' +
      ENDPOINTS_TRIED.join('; ') +
      '. Consider building a custom indexer or partnering with Vertex team.',
  }
}

// ── Exported entry point ──

export async function fetchVertex(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period)
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
