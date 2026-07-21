/**
 * Deterministic native-board eligibility shared by Tier-B profile crawls and
 * derived-board publication. The cohort is the de-duplicated top-N membership
 * of each latest PASSED native snapshot declared by the source.
 */

import { getIngestPool } from './db'
import { nativeRankingTimeframes } from './sources'
import type { SourceRow } from './core/types'

type NativeTimeframe = 7 | 30 | 90

interface NativeSnapshotRow {
  snapshot_id: number
  timeframe: NativeTimeframe
}

interface NativeMembershipRow {
  id: number
  exchange_trader_id: string
  meta: Record<string, unknown> | null
  timeframe: NativeTimeframe
  headline_roi: number | null
}

export interface NativeCohortTrader {
  id: number
  exchange_trader_id: string
  meta: Record<string, unknown> | null
  /** Native timeframe -> latest board headline ROI. */
  headline_rois: Record<string, number | null>
}

export interface NativeCohortResult {
  traders: NativeCohortTrader[]
  nativeTimeframes: NativeTimeframe[]
  foundTimeframes: NativeTimeframe[]
  missingTimeframes: NativeTimeframe[]
}

export interface NativeCohortOptions {
  /** Exclude owner-claimed traders whose first-party sync supersedes Tier-B. */
  excludeClaimed?: boolean
  /** Return traders with no marker or a marker older than this cutoff. */
  profileCursor?: {
    kind: string
    stalerThan: Date
  }
}

type NativeCohortSource = Pick<SourceRow, 'id' | 'timeframes_native' | 'deep_profile_topn'>

function normalizedNativeTimeframes(src: NativeCohortSource): NativeTimeframe[] {
  return [...new Set(nativeRankingTimeframes(src))].sort((a, b) => a - b)
}

/**
 * Resolve snapshot IDs first, then bind membership to those immutable IDs.
 * This keeps both callers on the same cohort contract even if a newer crawl
 * publishes between the two queries.
 */
export async function getLatestPassedNativeCohort(
  src: NativeCohortSource,
  options: NativeCohortOptions = {}
): Promise<NativeCohortResult> {
  const nativeTimeframes = normalizedNativeTimeframes(src)
  if (nativeTimeframes.length === 0) {
    return { traders: [], nativeTimeframes, foundTimeframes: [], missingTimeframes: [] }
  }

  const { rows: snapshotRows } = await getIngestPool().query<NativeSnapshotRow>(
    `SELECT DISTINCT ON (timeframe) id AS snapshot_id, timeframe
       FROM arena.leaderboard_snapshots
      WHERE source_id = $1
        AND timeframe = ANY($2::int[])
        AND count_check_passed
        AND NOT is_derived
      ORDER BY timeframe, scraped_at DESC, id DESC`,
    [src.id, nativeTimeframes]
  )

  const foundSet = new Set(snapshotRows.map((row) => row.timeframe))
  const foundTimeframes = nativeTimeframes.filter((timeframe) => foundSet.has(timeframe))
  const missingTimeframes = nativeTimeframes.filter((timeframe) => !foundSet.has(timeframe))

  if (snapshotRows.length === 0) {
    return { traders: [], nativeTimeframes, foundTimeframes, missingTimeframes }
  }

  const cursorKind = options.profileCursor?.kind ?? null
  const stalerThan = options.profileCursor?.stalerThan.toISOString() ?? null
  const { rows: membershipRows } = await getIngestPool().query<NativeMembershipRow>(
    `SELECT t.id, t.exchange_trader_id, t.meta, e.timeframe, e.headline_roi
       FROM arena.leaderboard_entries e
       JOIN arena.traders t ON t.id = e.trader_id
       LEFT JOIN arena.ingest_cursors pc
              ON pc.trader_id = t.id AND pc.kind = $3::text
      WHERE e.snapshot_id = ANY($1::bigint[])
        AND e.rank <= $2
        AND ($4::boolean = false OR (t.meta->>'claimed') IS DISTINCT FROM 'true')
        AND ($3::text IS NULL OR pc.updated_at IS NULL OR pc.updated_at < $5::timestamptz)
      ORDER BY t.id, e.timeframe`,
    [
      snapshotRows.map((row) => row.snapshot_id),
      src.deep_profile_topn,
      cursorKind,
      options.excludeClaimed ?? false,
      stalerThan,
    ]
  )

  const tradersById = new Map<number, NativeCohortTrader>()
  for (const row of membershipRows) {
    const trader = tradersById.get(row.id) ?? {
      id: row.id,
      exchange_trader_id: row.exchange_trader_id,
      meta: row.meta,
      headline_rois: {},
    }
    trader.headline_rois[String(row.timeframe)] = row.headline_roi
    tradersById.set(row.id, trader)
  }

  return {
    traders: [...tradersById.values()],
    nativeTimeframes,
    foundTimeframes,
    missingTimeframes,
  }
}
