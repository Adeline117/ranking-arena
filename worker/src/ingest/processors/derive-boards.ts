/**
 * Derived-leaderboard synthesis (spec §1.1-C, §6 derived-board labeling).
 *
 * GENERIC: for any source with timeframes_derived non-empty (MEXC 30/90,
 * BTCC later), synthesize a leaderboard snapshot per derived TF by ranking
 * the source's own arena.trader_stats rows for that timeframe — the stats
 * that Tier-B/Tier-C profile crawls deposited (the derived boards' only
 * substrate). Published through the normal gate with is_derived=true; the
 * frontend renders DerivedBoardBadge from snapshots.is_derived.
 *
 * Coverage semantics (spec §6): the board only contains traders whose
 * profiles were crawled (topN via Tier-B + on-demand Tier-C) — coverage
 * limited to recently ranked traders, which is exactly what the badge
 * discloses. Count check: there is no upstream count to compare against,
 * so expectedCountOverride=null → bootstrap cycles pass on actual; after 3
 * derived snapshots the rolling median guards against coverage collapse.
 *
 * Scheduling: scheduler.ts upserts `derive:{slug}` at the Tier-A cadence
 * for every active source with timeframes_derived.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug } from '@/lib/ingest/sources'
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
          AND s.timeframe = $2
          AND s.${sortColumn} IS NOT NULL
          AND s.as_of > now() - make_interval(hours => $3)
        ORDER BY s.${sortColumn} DESC`,
      [src.id, timeframe, maxAgeHours]
    )

    if (rows.length === 0) {
      // Nothing to rank (no profile stats yet) — publishing an empty PASSED
      // snapshot would poison the rolling baseline, so skip entirely.
      console.log(`[derive-boards] ${src.slug} ${timeframe}d: no fresh stats — skipping`)
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
      expectedCountOverride: null,
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
