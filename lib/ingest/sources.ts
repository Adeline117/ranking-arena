/**
 * arena.sources loaders — per-source orchestrator config lives in the DB,
 * never hardcoded in TS (spec §2.1). WORKER-ONLY MODULE (direct PG).
 */

import { getIngestPool } from './db'
import type { SourceRow } from './core/types'

const SOURCE_COLUMNS = `
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  leaderboard_url, timeframes_native, timeframes_derived, tf_label_map,
  expected_count, deep_profile_topn, positions_topn,
  profile_cache_ttl::text AS profile_cache_ttl,
  copier_table_depth, currency, page_size, pagination_kind,
  cadence_tier_a::text AS cadence_tier_a,
  cadence_tier_b::text AS cadence_tier_b,
  cadence_tier_d::text AS cadence_tier_d,
  EXTRACT(EPOCH FROM cadence_tier_a)::int AS cadence_tier_a_seconds,
  EXTRACT(EPOCH FROM cadence_tier_b)::int AS cadence_tier_b_seconds,
  EXTRACT(EPOCH FROM cadence_tier_d)::int AS cadence_tier_d_seconds,
  EXTRACT(EPOCH FROM profile_cache_ttl)::int AS profile_cache_ttl_seconds,
  fetch_region, rate_budget_ms, phase, serving_mode, status, meta
`

export interface SourceRowWithCadence extends SourceRow {
  cadence_tier_a_seconds: number
  cadence_tier_b_seconds: number
  cadence_tier_d_seconds: number
  profile_cache_ttl_seconds: number
}

export async function getActiveSources(): Promise<SourceRowWithCadence[]> {
  const { rows } = await getIngestPool().query<SourceRowWithCadence>(
    `SELECT ${SOURCE_COLUMNS} FROM arena.sources WHERE status = 'active' ORDER BY slug`
  )
  return rows
}

export async function getSourceBySlug(slug: string): Promise<SourceRowWithCadence> {
  const { rows } = await getIngestPool().query<SourceRowWithCadence>(
    `SELECT ${SOURCE_COLUMNS} FROM arena.sources WHERE slug = $1`,
    [slug]
  )
  if (rows.length === 0) throw new Error(`[ingest] unknown source slug: ${slug}`)
  return rows[0]
}

/** Ranking TFs this source natively exposes (boards only ever use 7/30/90). */
export function nativeRankingTimeframes(src: SourceRow): Array<7 | 30 | 90> {
  return src.timeframes_native.filter((tf): tf is 7 | 30 | 90 => tf === 7 || tf === 30 || tf === 90)
}
