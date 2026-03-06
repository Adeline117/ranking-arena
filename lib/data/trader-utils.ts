/**
 * Core utility functions for trader data lookups.
 * Eliminates duplicate code with unified source-finding logic.
 */

import { supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import {
  TRADER_SOURCES,
  TRADER_SOURCES_WITH_WEB3,
  type TraderSourceRecord,
} from './trader-types'

/**
 * 统一的交易员数据源查找函数
 * 使用单次查询替代循环遍历所有数据源
 */
export async function findTraderAcrossSources(
  handle: string,
  options: {
    includeWeb3?: boolean
    client?: SupabaseClient
  } = {}
): Promise<TraderSourceRecord | null> {
  const { includeWeb3 = true, client = supabase } = options
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

    // 如果有多个结果，优先返回有快照数据的
    if (data.length > 1) {
      const traderIds = data.map(d => d.source_trader_id)

      const { data: snapshots } = await client
        .from('trader_snapshots')
        .select('source_trader_id')
        .in('source_trader_id', traderIds)
        .limit(traderIds.length)

      if (snapshots && snapshots.length > 0) {
        const snapshotIds = new Set(snapshots.map(s => s.source_trader_id))
        const withSnapshot = data.find(d => snapshotIds.has(d.source_trader_id))
        if (withSnapshot) {
          return withSnapshot as TraderSourceRecord
        }
      }
    }

    return data[0] as TraderSourceRecord
  } catch (_error) {
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
    const handleList = Array.from(allHandles)

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
  } catch (_error) {
    return result
  }
}

/**
 * 获取交易员的 Arena 粉丝数（批量版本）
 */
export async function getTraderArenaFollowersCountBatch(
  client: SupabaseClient,
  traderIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (traderIds.length === 0) return result

  try {
    const { data, error } = await client
      .from('trader_follows')
      .select('trader_id')
      .in('trader_id', traderIds)

    if (error || !data) return result

    const counts = new Map<string, number>()
    data.forEach((row: { trader_id: string }) => {
      counts.set(row.trader_id, (counts.get(row.trader_id) || 0) + 1)
    })

    return counts
  } catch (_error) {
    return result
  }
}

export { createLogger }
