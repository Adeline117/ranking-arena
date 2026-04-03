/**
 * Arena Data Pipeline - Storage Layer
 *
 * 职责：持久化数据到 Supabase
 * - trader_sources (身份)
 * - trader_snapshots_v2 (快照)
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { EnrichedTraderData, PersistResult } from './types'
import { createLogger } from '@/lib/utils/logger'


const log = createLogger('pipeline:storage')

/** Truncate timestamp to hour boundary for partitioned upsert dedup */
function truncateToHour(isoOrDate?: string | Date | null): string {
  const d = isoOrDate ? new Date(isoOrDate) : new Date()
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

// =============================================================================
// Main Storage Class
// =============================================================================

export class PipelineStorage {
  private batchSize: number

  constructor(options?: { batchSize?: number }) {
    this.batchSize = options?.batchSize ?? 500
  }

  /**
   * 主入口：持久化数据
   */
  async persist(
    supabase: SupabaseClient,
    traders: EnrichedTraderData[]
  ): Promise<PersistResult> {
    if (traders.length === 0) {
      return { upserted: 0, errors: 0 }
    }

    const stats = {
      upserted: 0,
      errors: 0,
      details: {
        sources_upserted: 0,
        snapshots_upserted: 0,
      },
    }

    // 批量处理
    const batches = this.chunk(traders, this.batchSize)

    for (const batch of batches) {
      try {
        // 1. Upsert trader_sources（身份）
        const sourcesResult = await this.upsertSources(supabase, batch)
        stats.details.sources_upserted += sourcesResult.count

        // 2. Upsert trader_snapshots_v2（快照）
        const snapshotsResult = await this.upsertSnapshots(supabase, batch)
        stats.details.snapshots_upserted += snapshotsResult.count
        stats.upserted += snapshotsResult.count
      } catch (error) {
        log.error('Batch persist failed', { error: error instanceof Error ? error.message : String(error) })
        stats.errors += batch.length
      }
    }

    return stats
  }

  /**
   * Upsert traders (unified identity table, replaces trader_sources + trader_profiles_v2)
   */
  private async upsertSources(
    supabase: SupabaseClient,
    traders: EnrichedTraderData[]
  ): Promise<{ count: number }> {
    // 准备数据 — use `traders` table (merged identity table since 2026-03-18)
    const traderRows = traders.map((t) => ({
      platform: t.platform,
      trader_key: t.trader_id,
      market_type: 'futures' as string,  // EnrichedTraderData doesn't carry market_type; default to futures
      handle: t.display_name,
      avatar_url: t.avatar_url,
      is_active: true,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    // 按 (platform, trader_key) 去重
    const unique = this.dedupeBy(traderRows, (s) => `${s.platform}:${s.trader_key}`)

    // Upsert
    const { error, count } = await supabase
      .from('traders')
      .upsert(unique, {
        onConflict: 'platform,trader_key',
        ignoreDuplicates: false,
      })

    if (error) {
      log.error('upsertSources error', { error: error instanceof Error ? error.message : String(error) })
      // 不抛出，允许继续
    }

    return { count: count ?? unique.length }
  }

  /**
   * Upsert trader_snapshots_v2
   */
  private async upsertSnapshots(
    supabase: SupabaseClient,
    traders: EnrichedTraderData[]
  ): Promise<{ count: number }> {
    // 准备数据
    const snapshots = traders.map((t) => ({
      platform: t.platform,
      trader_key: t.trader_id,
      window: t.window.toUpperCase(), // '7D', '30D', '90D'
      roi_pct: t.roi_pct,
      pnl_usd: t.pnl_usd,
      win_rate: t.win_rate_pct,
      max_drawdown: t.max_drawdown_pct,
      followers: t.followers,
      copiers: t.copiers,
      aum: t.aum_usd,
      trades_count: t.trades_count,
      arena_score: t.arena_score,
      arena_score_components: t.arena_score_components,
      platform_rank: t.platform_rank,
      trader_type: t.trader_type,
      confidence_level: t.confidence,
      sharpe_ratio: t.sharpe_ratio,
      sortino_ratio: t.sortino_ratio,
      as_of_ts: truncateToHour(t.normalized_at),
      updated_at: new Date().toISOString(),
    }))

    // Upsert
    const { error, count } = await supabase
      .from('trader_snapshots_v2')
      .upsert(snapshots, {
        onConflict: 'platform,market_type,trader_key,window,as_of_ts',
        ignoreDuplicates: false,
        count: 'exact',
      })

    if (error) {
      log.error('upsertSnapshots error', { error: error instanceof Error ? error.message : String(error) })
      throw error // 这个错误需要抛出
    }

    return { count: count ?? snapshots.length }
  }

  /**
   * 批量写入 leaderboard_ranks（用于 compute-leaderboard cron）
   */
  async persistLeaderboardRanks(
    supabase: SupabaseClient,
    traders: EnrichedTraderData[],
    seasonId: string
  ): Promise<{ count: number }> {
    const ranks = traders.map((t, index) => ({
      source: t.platform,
      source_trader_id: t.trader_id,
      season_id: seasonId,
      rank: index + 1, // 假设已排序
      roi: t.roi_pct,
      pnl: t.pnl_usd,
      win_rate: t.win_rate_pct,
      max_drawdown: t.max_drawdown_pct,
      arena_score: t.arena_score,
      return_score: t.arena_score_components.return_score,
      pnl_score: t.arena_score_components.pnl_score,
      confidence: t.confidence,
      trader_type: t.trader_type,
      updated_at: new Date().toISOString(),
    }))

    const { error, count } = await supabase
      .from('leaderboard_ranks')
      .upsert(ranks, {
        onConflict: 'source,source_trader_id,season_id',
        count: 'exact',
      })

    if (error) {
      log.error('persistLeaderboardRanks error', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }

    return { count: count ?? ranks.length }
  }

  /**
   * 批量写入 trader_daily_snapshots（用于 aggregate-daily-snapshots cron）
   */
  async persistDailySnapshots(
    supabase: SupabaseClient,
    traders: EnrichedTraderData[],
    date: string // 'YYYY-MM-DD'
  ): Promise<{ count: number }> {
    const dailySnapshots = traders.map((t) => ({
      date,
      platform: t.platform,
      trader_key: t.trader_id,
      roi: t.roi_pct,
      pnl: t.pnl_usd,
      win_rate: t.win_rate_pct,
      max_drawdown: t.max_drawdown_pct,
      followers: t.followers,
      trades_count: t.trades_count,
      arena_score: t.arena_score,
      created_at: new Date().toISOString(),
    }))

    const { error, count } = await supabase
      .from('trader_daily_snapshots')
      .upsert(dailySnapshots, {
        onConflict: 'date,platform,trader_key',
        count: 'exact',
      })

    if (error) {
      log.error('persistDailySnapshots error', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }

    return { count: count ?? dailySnapshots.length }
  }

  // =============================================================================
  // Helper Methods
  // =============================================================================

  /**
   * 数组分块
   */
  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }

  /**
   * 按 key 去重
   */
  private dedupeBy<T>(array: T[], keyFn: (item: T) => string): T[] {
    const seen = new Set<string>()
    return array.filter((item) => {
      const key = keyFn(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let storageInstance: PipelineStorage | null = null

export function getStorage(): PipelineStorage {
  if (!storageInstance) {
    storageInstance = new PipelineStorage()
  }
  return storageInstance
}
