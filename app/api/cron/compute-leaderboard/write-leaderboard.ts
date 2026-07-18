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
import { RANKING_SOURCE_FUTURE_TOLERANCE_MS } from '@/lib/rankings/source-freshness'

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

export interface SourceFreshnessWriteRow {
  season_id: Period
  source: string
  source_as_of: string
  recorded_at: string
}

/**
 * Collapse trader-level board-publication timestamps to one conservative
 * source watermark. Every row from a PASSED source board normally has the same
 * source_as_of; if a mixed board slips through, retaining the oldest timestamp
 * prevents the newer subset from hiding older source data.
 *
 * A source containing any invalid timestamp is omitted entirely. Its previous
 * last-good watermark then remains in place and naturally ages into stale.
 */
export function buildSourceFreshnessWriteRows(
  season: Period,
  traders: readonly ScoredTrader[],
  recordedAt = new Date().toISOString()
): SourceFreshnessWriteRow[] {
  const bySource = new Map<string, { oldestMs: number; invalid: boolean }>()
  const recordedAtMs = Date.parse(recordedAt)
  const latestAllowedMs =
    (Number.isFinite(recordedAtMs) ? recordedAtMs : Date.now()) + RANKING_SOURCE_FUTURE_TOLERANCE_MS

  for (const trader of traders) {
    const timestamp = Date.parse(trader.source_as_of)
    const current = bySource.get(trader.source)
    if (!Number.isFinite(timestamp) || timestamp > latestAllowedMs) {
      bySource.set(trader.source, {
        oldestMs: current?.oldestMs ?? Number.POSITIVE_INFINITY,
        invalid: true,
      })
      continue
    }
    bySource.set(trader.source, {
      oldestMs: Math.min(current?.oldestMs ?? timestamp, timestamp),
      invalid: current?.invalid ?? false,
    })
  }

  return [...bySource.entries()]
    .flatMap(([source, state]) =>
      state.invalid
        ? []
        : [
            {
              season_id: season,
              source,
              source_as_of: new Date(state.oldestMs).toISOString(),
              recorded_at: recordedAt,
            },
          ]
    )
    .sort((a, b) => a.source.localeCompare(b.source))
}

/**
 * Publish source watermarks only after the season's ranking writes complete.
 * Missing sources are intentionally not deleted/upserted: their last-good
 * watermark must remain visible and age honestly while their last-good ranks
 * continue to serve.
 */
export async function upsertSourceFreshness(params: {
  supabase: SupabaseClient
  season: Period
  scoredTraders: readonly ScoredTrader[]
}): Promise<number> {
  const { supabase, season, scoredTraders } = params
  const rows = buildSourceFreshnessWriteRows(season, scoredTraders)
  const sourceCount = new Set(scoredTraders.map((trader) => trader.source)).size

  if (rows.length < sourceCount) {
    logger.warn(
      `[${season}] source freshness skipped ${sourceCount - rows.length} source(s) with invalid board watermark`
    )
  }
  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('leaderboard_source_freshness')
    .upsert(rows, { onConflict: 'season_id,source' })
  if (error) {
    throw new Error(`[${season}] source freshness upsert failed: ${error.message}`)
  }
  return rows.length
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
  freshPlatforms: readonly string[]
  isOutOfTime: (buffer: number) => boolean
  upsertAborted: boolean
  timeLeftMs: () => number
}): Promise<number> {
  const {
    supabase,
    season,
    uniqueTraders,
    traderMap,
    freshPlatforms,
    isOutOfTime,
    upsertAborted,
    timeLeftMs,
  } = params

  if (upsertAborted || isOutOfTime(25_000)) {
    if (upsertAborted) logger.warn(`[${season}] SKIPPING zero-out (upsert aborted)`)
    else
      logger.warn(`[${season}] SKIPPING zero-out — only ${Math.round(timeLeftMs() / 1000)}s left`)
    return 0
  }

  const computedTraderIds = new Set(uniqueTraders.map((t) => `${t.source}:${t.source_trader_id}`))
  const freshPlatformSet = new Set(freshPlatforms)
  const allInTraderMap = new Set(
    Array.from(traderMap.values())
      .filter((trader) => freshPlatformSet.has(trader.source))
      .map((t) => `${t.source}:${t.source_trader_id}`)
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
