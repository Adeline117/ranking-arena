/**
 * Derived-leaderboard synthesis (spec §1.1-C, §6 derived-board labeling).
 *
 * GENERIC: for any source with timeframes_derived non-empty (MEXC 30/90,
 * BTCC later), synthesize a leaderboard snapshot per derived TF by ranking
 * fresh profile stats for a deterministic eligibility cohort: the de-duplicated
 * top-N membership of every latest PASSED native board. Incidental Tier-C
 * long-tail traffic must never expand or collapse the derived board.
 *
 * Coverage semantics (spec §6): the eligible count is the upstream contract.
 * If fewer than 90% of eligible traders have fresh stats, fail closed and keep
 * the last-good derived snapshot. Passing crawls use the eligible count as the
 * count-gate bootstrap and a versioned baseline generation, so the historical
 * all-fresh-stats baseline cannot poison this bounded cohort.
 *
 * Scheduling: scheduler.ts upserts `derive:{slug}` at the Tier-A cadence
 * for every active source with timeframes_derived.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getLatestPassedNativeCohort } from '@/lib/ingest/native-cohort'
import type { ParsedLeaderboardRow, TraderKind, BotStrategy } from '@/lib/ingest/core/types'
import { publishLeaderboardSnapshot } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'
import { observationCycleId } from '../observation-cycle'

/** sources.meta.derived_board_sort → trader_stats column (default roi —
 *  matches the native boards' default sort, spec §9 #6). */
const SORT_COLUMNS: Record<string, string> = {
  roi: 'roi',
  pnl: 'pnl',
  win_rate: 'win_rate',
}

/** Stats older than this don't rank: a trader who left the native board
 *  stops being re-crawled, and their stale numbers must age out of the
 *  derived board rather than linger forever. Default 48h covers 2 Tier-B
 *  cycles at the 18h cadence; override via meta.derived_stats_max_age_hours. */
const DEFAULT_MAX_STAT_AGE_HOURS = 48

/** Conservative launch gate: at most 10% of the deterministic cohort may be stale. */
export const DERIVED_MIN_FRESH_COVERAGE_PCT = 90

/**
 * Changing the eligibility contract must change this generation. Count-baseline
 * reads are scoped to the generation stored in snapshot meta, explicitly
 * excluding the old unbounded Tier-C-inflated history.
 */
export const DERIVED_COUNT_BASELINE_GENERATION = 'derived-native-eligibility-v1'

interface StatsRow {
  exchange_trader_id: string
  nickname: string | null
  avatar_url_origin: string | null
  wallet_address: string | null
  trader_kind: TraderKind
  bot_strategy: BotStrategy | null
  roi: string | null
  pnl: string | null
  win_rate: string | null
  as_of: string
}

export interface DeriveBoardResult {
  timeframe: number
  actualCount: number
  passed: boolean
  snapshotId: number
}

function num(v: string | null): number | null {
  if (v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function coveragePct(freshCount: number, eligibleCount: number): number {
  return eligibleCount === 0 ? 0 : (freshCount / eligibleCount) * 100
}

export async function processDeriveBoards(job: Job<TierJobData>): Promise<DeriveBoardResult[]> {
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') {
    console.log(`[derive-boards] ${src.slug} is ${src.status} — skipping`)
    return []
  }

  const derivedTfs = src.timeframes_derived.filter(
    (tf): tf is 7 | 30 | 90 => tf === 7 || tf === 30 || tf === 90
  )
  if (derivedTfs.length === 0) return []

  const sortKey =
    typeof src.meta.derived_board_sort === 'string' ? src.meta.derived_board_sort : 'roi'
  const sortColumn = SORT_COLUMNS[sortKey] ?? 'roi'
  const maxAgeHours = Number(src.meta.derived_stats_max_age_hours) || DEFAULT_MAX_STAT_AGE_HOURS
  const cycleId = observationCycleId(job, 'derive', src.slug)
  const nativeCohort = await getLatestPassedNativeCohort(src)
  if (nativeCohort.missingTimeframes.length > 0) {
    console.error(
      `[derive-boards] P0 coverage gate ${src.slug}: missing latest PASSED native ` +
        `board(s) [${nativeCohort.missingTimeframes.map((tf) => `${tf}d`).join(',')}]; ` +
        `required=[${nativeCohort.nativeTimeframes.map((tf) => `${tf}d`).join(',')}]; ` +
        `keeping last good`
    )
    return []
  }

  const eligibleTraderIds = nativeCohort.traders.map((trader) => trader.id)

  if (eligibleTraderIds.length === 0) {
    console.error(
      `[derive-boards] P0 coverage gate ${src.slug}: no eligible traders from latest ` +
        `PASSED native board; keeping last good`
    )
    return []
  }

  const results: DeriveBoardResult[] = []
  for (const timeframe of derivedTfs) {
    // sortColumn is registry-constrained (never user input) — safe to inline.
    const { rows } = await getIngestPool().query<StatsRow>(
      `SELECT t.exchange_trader_id, t.nickname, t.avatar_url_origin, t.wallet_address,
              t.trader_kind, t.bot_strategy,
              s.roi::text, s.pnl::text, s.win_rate::text, s.as_of::text AS as_of
         FROM arena.trader_stats s
         JOIN arena.traders t ON t.id = s.trader_id
        WHERE t.source_id = $1
          AND t.id = ANY($2::bigint[])
          AND s.timeframe = $3
          AND s.${sortColumn} IS NOT NULL
          AND s.as_of > now() - make_interval(hours => $4)
        ORDER BY s.${sortColumn} DESC`,
      [src.id, eligibleTraderIds, timeframe, maxAgeHours]
    )

    const freshCoveragePct = coveragePct(rows.length, eligibleTraderIds.length)
    if (freshCoveragePct < DERIVED_MIN_FRESH_COVERAGE_PCT) {
      console.error(
        `[derive-boards] P0 coverage gate ${src.slug} ${timeframe}d: ` +
          `fresh=${rows.length}/${eligibleTraderIds.length} ` +
          `(${freshCoveragePct.toFixed(1)}%, required>=${DERIVED_MIN_FRESH_COVERAGE_PCT}%); ` +
          `keeping last good`
      )
      continue
    }

    const parsedRows: ParsedLeaderboardRow[] = rows.map((row, i) => ({
      exchangeTraderId: row.exchange_trader_id,
      rank: i + 1,
      nickname: row.nickname,
      avatarUrlOrigin: row.avatar_url_origin,
      walletAddress: row.wallet_address,
      traderKind: row.trader_kind,
      botStrategy: row.bot_strategy,
      headlineRoi: num(row.roi),
      headlinePnl: num(row.pnl),
      headlineWinRate: num(row.win_rate),
      raw: { derived: true, derived_sort: sortColumn, stats_as_of: row.as_of },
    }))

    const published = await publishLeaderboardSnapshot({
      src,
      timeframe,
      rows: parsedRows,
      rejects: [],
      rawObjectId: null, // no upstream payload — the substrate is our own DB
      isDerived: true,
      expectedCountOverride: eligibleTraderIds.length,
      countBaselineGeneration: DERIVED_COUNT_BASELINE_GENERATION,
      observationCycleId: cycleId ?? undefined,
    })

    console.log(
      `[derive-boards] ${src.slug} ${timeframe}d: ${parsedRows.length} rows, ` +
        `passed=${published.verdict.passed} (baseline=${published.verdict.baselineUsed})`
    )
    results.push({
      timeframe,
      actualCount: parsedRows.length,
      passed: published.verdict.passed,
      snapshotId: published.snapshotId,
    })
  }
  return results
}
