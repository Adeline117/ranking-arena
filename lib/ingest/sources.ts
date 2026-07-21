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

/**
 * The full set of source NAMES the frontend read-path treats as "serving"
 * (ARENA_DATA_SPEC §2.4 serving_mode). A source is serving iff
 * serving_mode='serving'; the frontend resolves traders by both the arena slug
 * AND the legacy platform alias (meta.legacy_platform), so both are emitted.
 *
 * This is the DB-side twin of the public.arena_serving_sources() RPC — the
 * worker scheduler mirrors this into the Redis `serving_sources` key each
 * reconcile so the frontend hot path stays fast AND the list can never drift
 * from the DB (no manual editing). Keep the two queries in lockstep.
 */
export async function getServingSourceNames(): Promise<string[]> {
  const { rows } = await getIngestPool().query<{ name: string }>(
    `SELECT slug AS name FROM arena.sources WHERE serving_mode = 'serving'
     UNION
     SELECT meta->>'legacy_platform' FROM arena.sources
       WHERE serving_mode = 'serving' AND coalesce(meta->>'legacy_platform', '') <> ''
     ORDER BY name`
  )
  return rows.map((r) => r.name)
}

/** Ranking TFs this source natively exposes (boards only ever use 7/30/90). */
export function nativeRankingTimeframes(
  src: Pick<SourceRow, 'timeframes_native'>
): Array<7 | 30 | 90> {
  return src.timeframes_native.filter((tf): tf is 7 | 30 | 90 => tf === 7 || tf === 30 || tf === 90)
}

/**
 * TFs profile crawls must cover: native ∪ derived (spec §1.1-C). Derived
 * boards (MEXC/BTCC 30/90) are synthesized FROM trader_stats rows, so
 * Tier-B must crawl profiles for the derived TFs too — they are the
 * derived boards' only substrate. Tier A still crawls native TFs only.
 */
export function profileTimeframes(src: SourceRow): Array<7 | 30 | 90> {
  const wanted = new Set([...src.timeframes_native, ...src.timeframes_derived])
  return ([7, 30, 90] as const).filter((tf) => wanted.has(tf))
}
