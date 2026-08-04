/**
 * Write leaderboard — batch upsert and zero-out logic.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import type { ScoredTrader } from './score-traders'
import type { TraderRow } from './trader-row'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { validateBeforeWrite, logRejectedWrites } from '@/lib/validation/data-write-gate'
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

export interface SourceFreshnessEvidence {
  source: string
  source_as_of: string
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
  traders: readonly SourceFreshnessEvidence[],
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
 * Gate a completed season write with one conservative watermark per finalized
 * source. Missing sources are never deleted, so absent sources retain their
 * last-good state. A source present in this cohort is different: if its
 * watermark cannot be proven, the whole gate fails before any watermark write.
 * This legacy upsert is not the proof-carrying atomic publication seal.
 */
export async function upsertSourceFreshness(params: {
  supabase: SupabaseClient
  season: Period
  expectedSources: readonly string[]
  sourceEvidence: readonly SourceFreshnessEvidence[]
}): Promise<number> {
  const { supabase, season, expectedSources, sourceEvidence } = params
  const expectedSourceSet = new Set(expectedSources)
  const rows = buildSourceFreshnessWriteRows(season, sourceEvidence)
  const rowSourceSet = new Set(rows.map((row) => row.source))

  if (expectedSourceSet.size === 0) {
    throw new Error(`[${season}] source freshness gate requires at least one fresh source`)
  }
  const unexpectedEvidence = sourceEvidence.some(
    (evidence) => !expectedSourceSet.has(evidence.source)
  )
  const hasExactSourceSet =
    rows.length === expectedSourceSet.size &&
    [...expectedSourceSet].every((source) => rowSourceSet.has(source))
  if (unexpectedEvidence || !hasExactSourceSet) {
    throw new Error(
      `[${season}] source freshness gate incomplete: ${rows.length}/${expectedSourceSet.size} fresh sources have valid board watermarks`
    )
  }

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
  prevRankMap: Map<string, number>
  isOutOfTime: (buffer: number) => boolean
  timeLeftMs: () => number
}): Promise<{ upsertErrors: number; upsertAborted: boolean }> {
  const { supabase, season, changedTraders, prevRankMap, isOutOfTime, timeLeftMs } = params
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
      const prevRank = prevRankMap.get(key)
      return {
        season_id: season,
        source: t.source,
        source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
        source_trader_id: t.source_trader_id,
        // Preserve the current live pre-write rank until the transaction-scoped
        // reranker has the complete post-cleanup cohort. New rows begin NULL.
        // This prevents provisional application ordering from becoming public
        // authority between batch writes. Movement remains unknown until a
        // generation-aware last-published baseline exists.
        rank: prevRank ?? null,
        rank_change: null,
        // A live row has no generation-aware last-published baseline yet.
        // Withhold NEW instead of emitting a transient, unprovable label on
        // rank-null profile/raw readers between PostgREST transactions.
        is_new: false,
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
        is_outlier: t.is_outlier === true,
        metrics_estimated: t.metrics_estimated,
      }
    })

    // Validate batch before write
    const { valid: validBatch, rejected } = validateBeforeWrite(batch, 'leaderboard_ranks')
    if (rejected.length) {
      await logRejectedWrites(rejected, supabase)
      // Validation rejection is a failed publication row, not a harmless
      // omission. Propagate it so the route cannot cleanup or checkpoint a
      // cohort that was only partially persisted.
      upsertErrors += rejected.length
    }

    if (validBatch.length > 0) {
      // Guarantee trader_sources parent rows exist
      const parentRows = validBatch.map((row) => ({
        source: row.source,
        source_trader_id: row.source_trader_id,
        source_type: row.source_type,
        handle: row.handle,
        avatar_url: row.avatar_url,
        is_active: true,
        identity_type: 'public',
        source_kind: getSourceKind(row.source),
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
        .upsert(validBatch, { onConflict: 'season_id,source,source_trader_id' })
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
 * but excluded from computation (negative ROI, < min trades, etc.). This is a
 * current-cohort finalization step: deadline, partial-upsert, and database
 * failures propagate so callers cannot publish a watermark or checkpoint for
 * an incompletely finalized board.
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

  if (upsertAborted) {
    throw new Error(`[${season}] zero-out refused because leaderboard upsert was aborted`)
  }
  if (isOutOfTime(25_000)) {
    throw new Error(
      `[${season}] zero-out deadline reached with ${Math.round(timeLeftMs() / 1000)}s remaining`
    )
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
    for (let i = 0; i < ids.length; i += 100) {
      if (isOutOfTime(20_000)) {
        throw new Error(
          `[${season}] zero-out deadline reached after ${zeroed} traders with ${Math.round(timeLeftMs() / 1000)}s remaining`
        )
      }
      const batch = ids.slice(i, i + 100)
      let zeroResult: { error: { message: string } | null }
      try {
        zeroResult = (await supabase
          .from('leaderboard_ranks')
          .update({ arena_score: 0, computed_at: new Date().toISOString() })
          .eq('season_id', season)
          .eq('source', source)
          .in('source_trader_id', batch)
          .gt('arena_score', 0)) as typeof zeroResult
      } catch (error) {
        throw new Error(
          `[${season}] zero-out update threw for ${source}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      if (zeroResult.error) {
        throw new Error(
          `[${season}] zero-out update failed for ${source}: ${zeroResult.error.message}`
        )
      }
      zeroed += batch.length
    }
  }

  if (zeroed > 0) {
    logger.info(`${season}: zeroed out ${zeroed} excluded traders (batched by source)`)
  }

  return zeroed
}
