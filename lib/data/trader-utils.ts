/**
 * @deprecated Use `lib/data/unified.ts` (specifically `resolveTrader()`) instead. This file
 * contains legacy trader lookup utilities that query trader_sources directly. They are still
 * used by trader-queries.ts but should not be used in new code.
 *
 * Core utility functions for trader data lookups.
 * Eliminates duplicate code with unified source-finding logic.
 */

import { supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trader-utils')
import {
  TRADER_SOURCES,
  TRADER_SOURCES_WITH_WEB3,
  type TraderSourceRecord,
} from './trader-types'

// Request-scoped cache for findTraderAcrossSources to eliminate N+1 lookups.
// On a trader detail page, 8+ functions call findTraderAcrossSources(handle) independently.
// This Map caches results so only the first call hits the DB; subsequent calls return instantly.
// The cache lives for the lifetime of the serverless function invocation (~seconds), so no TTL needed.
const sourceCache = new Map<string, Promise<TraderSourceRecord | null>>()

/**
 * Clear the request-scoped source cache.
 * Call this at the start of a new request if reusing the module across requests.
 */
export function clearSourceCache() {
  sourceCache.clear()
}

/**
 * 统一的交易员数据源查找函数
 * 使用单次查询替代循环遍历所有数据源
 * Results are cached per handle within the same request to avoid N+1 queries.
 */
export async function findTraderAcrossSources(
  handle: string,
  options: {
    includeWeb3?: boolean
    client?: SupabaseClient
  } = {}
): Promise<TraderSourceRecord | null> {
  const { includeWeb3 = true, client = supabase } = options

  // Check request-scoped cache first (eliminates N+1 on trader detail pages)
  const cacheKey = `${handle}:${includeWeb3}`
  const cached = sourceCache.get(cacheKey)
  if (cached) return cached

  // Store the promise itself (not the result) to deduplicate concurrent calls
  const promise = findTraderAcrossSourcesInner(handle, includeWeb3, client)
  sourceCache.set(cacheKey, promise)
  return promise
}

async function findTraderAcrossSourcesInner(
  handle: string,
  includeWeb3: boolean,
  client: SupabaseClient
): Promise<TraderSourceRecord | null> {
  const decodedHandle = decodeURIComponent(handle)
  const sources = includeWeb3 ? TRADER_SOURCES_WITH_WEB3 : TRADER_SOURCES

  try {
    const handleConditions = [
      `handle.eq.${handle}`,
      `source_trader_id.eq.${handle}`,
    ]

    if (decodedHandle !== handle) {
      handleConditions.push(`handle.eq.${decodedHandle}`)
      handleConditions.push(`source_trader_id.eq.${decodedHandle}`)
    }

    const { data, error } = await client
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url, source')
      .in('source', sources as unknown as string[])
      .or(handleConditions.join(','))
      .limit(10)

    if (error) {
      return null
    }

    if (!data || data.length === 0) {
      return null
    }

    // 如果有多个结果，优先返回有排名数据的
    if (data.length > 1) {
      const traderIds = data.map(d => d.source_trader_id)

      const { data: rankedTraders } = await client
        .from('leaderboard_ranks')
        .select('source_trader_id')
        .in('source_trader_id', traderIds)
        .eq('season_id', '90D')
        .limit(traderIds.length)

      if (rankedTraders && rankedTraders.length > 0) {
        const rankedIds = new Set(rankedTraders.map(s => s.source_trader_id))
        const withRank = data.find(d => rankedIds.has(d.source_trader_id))
        if (withRank) {
          return withRank as TraderSourceRecord
        }
      }
    }

    return data[0] as TraderSourceRecord
  } catch (error) {
    logger.warn('findTraderAcrossSources failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * 批量获取多个交易员的数据源信息
 */
export async function findTradersAcrossSources(
  handles: string[],
  options: {
    includeWeb3?: boolean
    client?: SupabaseClient
  } = {}
): Promise<Map<string, TraderSourceRecord>> {
  const { includeWeb3 = true, client = supabase } = options
  const sources = includeWeb3 ? TRADER_SOURCES_WITH_WEB3 : TRADER_SOURCES
  const result = new Map<string, TraderSourceRecord>()

  if (handles.length === 0) return result

  try {
    const allHandles = new Set<string>()
    handles.forEach(h => {
      allHandles.add(h)
      const decoded = decodeURIComponent(h)
      if (decoded !== h) allHandles.add(decoded)
    })
    // Sanitize handles to prevent PostgREST filter injection via special chars
    const handleList = Array.from(allHandles).filter(h => !/[(),"]/.test(h))
    if (handleList.length === 0) return result

    const { data, error } = await client
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url, source')
      .in('source', sources as unknown as string[])
      .or(`handle.in.(${handleList.join(',')}),source_trader_id.in.(${handleList.join(',')})`)

    if (error || !data) {
      return result
    }

    data.forEach(record => {
      const rec = record as TraderSourceRecord
      if (rec.handle) result.set(rec.handle, rec)
      result.set(rec.source_trader_id, rec)
    })

    return result
  } catch (error) {
    logger.warn('findTradersAcrossSources failed', { error: error instanceof Error ? error.message : String(error) })
    return result
  }
}

/**
 * 获取交易员的 Arena 粉丝数（批量版本）
 * Uses RPC count_trader_followers for GROUP BY count (1 row per trader, not 1 row per follow)
 */
export async function getTraderArenaFollowersCountBatch(
  client: SupabaseClient,
  traderIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (traderIds.length === 0) return result

  try {
    const { data, error } = await client
      .rpc('count_trader_followers', { trader_ids: traderIds })

    if (error || !data) return result

    for (const row of data as { trader_id: string; cnt: number }[]) {
      result.set(row.trader_id, row.cnt)
    }

    return result
  } catch (error) {
    logger.warn('getTraderArenaFollowersCountBatch failed', { error: error instanceof Error ? error.message : String(error) })
    return result
  }
}

export { createLogger }
