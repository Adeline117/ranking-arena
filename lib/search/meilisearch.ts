/**
 * Meilisearch client for instant trader search.
 *
 * Provides typo-tolerant, sub-50ms search across 34K+ traders
 * with faceted filtering by exchange, score range, and trader type.
 *
 * Falls back to Supabase ILIKE search if Meilisearch is unavailable.
 *
 * Inspired by meilisearch/meilisearch (56K★).
 */

import { logger } from '@/lib/logger'

const MEILI_URL = process.env.MEILISEARCH_URL || ''
const MEILI_SEARCH_KEY = process.env.MEILISEARCH_SEARCH_KEY || ''

interface MeiliSearchResult {
  id: string
  handle: string
  platform: string
  platform_name: string
  roi: number
  pnl: number
  arena_score: number
  win_rate: number | null
  max_drawdown: number | null
  followers: number | null
  rank: number
  trader_type: string | null
  avatar_url: string | null
}

interface MeiliResponse {
  hits: MeiliSearchResult[]
  query: string
  processingTimeMs: number
  estimatedTotalHits: number
}

/**
 * Check if Meilisearch is configured and available.
 */
export function isMeilisearchAvailable(): boolean {
  return !!(MEILI_URL && MEILI_SEARCH_KEY)
}

/**
 * Search traders via Meilisearch. Returns null if unavailable.
 */
export async function searchTradersMeili(
  query: string,
  options: {
    limit?: number
    platform?: string
    minScore?: number
    traderType?: string
    season?: string
  } = {}
): Promise<MeiliResponse | null> {
  if (!isMeilisearchAvailable()) return null

  const { limit = 20, platform, minScore, traderType, season = '90D' } = options

  // Build filter array
  const filters: string[] = []
  filters.push(`season_id = "${season}"`)
  if (platform) filters.push(`platform = "${platform}"`)
  if (minScore != null) filters.push(`arena_score >= ${minScore}`)
  if (traderType) filters.push(`trader_type = "${traderType}"`)

  try {
    const res = await fetch(`${MEILI_URL}/indexes/traders/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MEILI_SEARCH_KEY}`,
      },
      body: JSON.stringify({
        q: query,
        limit,
        filter: filters.join(' AND '),
        attributesToRetrieve: ['id', 'handle', 'platform', 'platform_name', 'roi', 'pnl', 'arena_score', 'win_rate', 'rank', 'trader_type', 'avatar_url', 'season_id'],
        attributesToHighlight: ['handle'],
        highlightPreTag: '<mark>',
        highlightPostTag: '</mark>',
      }),
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) {
      logger.warn(`[Meilisearch] Search failed: ${res.status}`)
      return null
    }

    return (await res.json()) as MeiliResponse
  } catch (err) {
    logger.warn('[Meilisearch] Search error:', err)
    return null
  }
}
