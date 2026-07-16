/**
 * Write leaderboard — batch upsert and zero-out logic.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import type { ScoredTrader } from './score-traders'
import type { TraderRow } from './trader-row'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { validateBeforeWrite, logRejectedWrites } from '@/lib/pipeline/validate-before-write'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

const DEX_SOURCES = new Set([
  'hyperliquid',
  'gmx',
  'dydx',
  'drift',
  'aevo',
  'gains',
  'jupiter_perps',
  'polymarket',
])

function getSourceKind(source: string): string {
  if (
    source.startsWith('binance_web3') ||
    source.startsWith('okx_web3') ||
    DEX_SOURCES.has(source)
  ) {
    return 'dex_leaderboard'
  }
  return 'cex_leaderboard'
}

/**
 * Upsert changed traders into leaderboard_ranks in batches.
 * Returns { upsertErrors, upsertAborted }.
 */
export async function upsertLeaderboard(params: {
  supabase: SupabaseClient
  season: Period
  changedTraders: ScoredTrader[]
  rankMap: Map<string, number>
  prevRankMap: Map<string, number>
  isOutOfTime: (buffer: number) => boolean
  timeLeftMs: () => number
}): Promise<{ upsertErrors: number; upsertAborted: boolean }> {
  const { supabase, season, changedTraders, rankMap, prevRankMap, isOutOfTime, timeLeftMs } = params
  let upsertErrors = 0
  let upsertAborted = false
  const batchUpsertSize = 50

  for (let i = 0; i < changedTraders.length; i += batchUpsertSize) {
    if (isOutOfTime(20_000)) {
      logger.warn(
        `[${season}] upsert loop aborted at ${i}/${changedTraders.length} — only ${Math.round(timeLeftMs() / 1000)}s left`
      )
      upsertAborted = true
      break
    }

    const batch = changedTraders.slice(i, i + batchUpsertSize).map((t) => {
      const key = `${t.source}:${t.source_trader_id}`
      const newRank = rankMap.get(key) ?? 0
      const prevRank = prevRankMap.get(key)
      const rankChange = prevRank != null ? prevRank - newRank : null
      return {
        season_id: season,
        source: t.source,
        source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
        source_trader_id: t.source_trader_id,
        rank: newRank,
        rank_change: rankChange,
        is_new: prevRank == null,
        arena_score: t.arena_score, // v4 (flagship, ranked by rerank RPC)
        arena_score_v4: t.arena_score_v4, // = arena_score (labeled)
        arena_score_v3: t.arena_score_v3, // rollback: pre-v4 score
        score_factors: t.score_factors, // v4 breakdown for the score UI
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.win_rate,
        max_drawdown: t.max_drawdown,
        followers: t.followers,
        copiers: t.copiers ?? null,
        trades_count: t.trades_count,
        handle: t.handle,
        avatar_url: t.avatar_url,
        computed_at: new Date().toISOString(),
        profitability_score: t.profitability_score,
        risk_control_score: t.risk_control_score,
        execution_score: t.execution_score,
        score_completeness: t.score_completeness,
        trading_style: t.trading_style,
        avg_holding_hours: t.avg_holding_hours,
        style_confidence: t.style_confidence,
        sharpe_ratio: t.sharpe_ratio,
        sortino_ratio: t.sortino_ratio ?? null,
        profit_factor: t.profit_factor ?? null,
        calmar_ratio: t.calmar_ratio ?? null,
        trader_type: t.trader_type || (t.source === 'web3_bot' ? 'bot' : null),
        is_outlier: (t as unknown as Record<string, unknown>).is_outlier === true ? true : false,
        metrics_estimated: t.metrics_estimated,
      }
    })

    // Validate batch before write
    const { valid: validBatch, rejected } = validateBeforeWrite(
      batch as Record<string, unknown>[],
      'leaderboard_ranks'
    )
    if (rejected.length) logRejectedWrites(rejected, supabase)

    if (validBatch.length > 0) {
      // Guarantee trader_sources parent rows exist
      const parentRows = (validBatch as Array<Record<string, unknown>>).map((r) => ({
        source: r.source as string,
        source_trader_id: r.source_trader_id as string,
        source_type: r.source_type as string | null,
        handle: r.handle as string | null,
        avatar_url: r.avatar_url as string | null,
        is_active: true,
        identity_type: 'public',
        source_kind: getSourceKind(r.source as string),
        last_seen_at: new Date().toISOString(),
      }))
      const { error: parentErr } = await supabase
        .from('trader_sources')
        .upsert(parentRows, { onConflict: 'source,source_trader_id', ignoreDuplicates: true })
      if (parentErr) {
        logger.warn(`[${season}] trader_sources parent-upsert non-fatal: ${parentErr.message}`)
      }

      const { error } = await supabase
        .from('leaderboard_ranks')
        .upsert(validBatch as any, { onConflict: 'season_id,source,source_trader_id' })
      if (error) {
        logger.error(`Upsert error for ${season} batch ${i}:`, error)
        upsertErrors += validBatch.length
      }
    }
  }

  return { upsertErrors, upsertAborted }
}

/**
 * Zero out arena_score for traders that were in traderMap (V2 data fresh)
 * but excluded from computation (negative ROI, < min trades, etc.).
 */
export async function zeroOutExcluded(params: {
  supabase: SupabaseClient
  season: Period
  uniqueTraders: TraderRow[]
  traderMap: Map<string, TraderRow>
  isOutOfTime: (buffer: number) => boolean
  upsertAborted: boolean
  timeLeftMs: () => number
}): Promise<number> {
  const { supabase, season, uniqueTraders, traderMap, isOutOfTime, upsertAborted, timeLeftMs } =
    params

  if (upsertAborted || isOutOfTime(25_000)) {
    if (upsertAborted) logger.warn(`[${season}] SKIPPING zero-out (upsert aborted)`)
    else
      logger.warn(`[${season}] SKIPPING zero-out — only ${Math.round(timeLeftMs() / 1000)}s left`)
    return 0
  }

  const computedTraderIds = new Set(uniqueTraders.map((t) => `${t.source}:${t.source_trader_id}`))
  const allInTraderMap = new Set(
    Array.from(traderMap.values()).map((t) => `${t.source}:${t.source_trader_id}`)
  )
  const excludedTraders = Array.from(allInTraderMap).filter((k) => !computedTraderIds.has(k))

  if (excludedTraders.length === 0) return 0

  // Group by source for batched UPDATE
  const excludedBySource = new Map<string, string[]>()
  for (const k of excludedTraders) {
    const [source, ...rest] = k.split(':')
    const id = rest.join(':')
    if (!excludedBySource.has(source)) excludedBySource.set(source, [])
    excludedBySource.get(source)!.push(id)
  }

  let zeroed = 0
  for (const [source, ids] of excludedBySource) {
    if (isOutOfTime(20_000)) {
      logger.warn(`[${season}] zero-out aborted after ${zeroed} traders`)
      break
    }
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      const { error: zeroErr } = await supabase
        .from('leaderboard_ranks')
        .update({ arena_score: 0, computed_at: new Date().toISOString() })
        .eq('season_id', season)
        .eq('source', source)
        .in('source_trader_id', batch)
        .gt('arena_score', 0)
      if (!zeroErr) zeroed += batch.length
    }
  }

  if (zeroed > 0) {
    logger.info(`${season}: zeroed out ${zeroed} excluded traders (batched by source)`)
  }

  return zeroed
}
