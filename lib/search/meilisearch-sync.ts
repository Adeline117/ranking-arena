/**
 * In-process Meilisearch trader-index sync for the ranking worker.
 *
 * Replaces the worker's former HTTP call to /api/cron/sync-meilisearch, which
 * is a V1 410 tombstone (the call could only ever fail). The source of truth is
 * the sealed public view `public.public_ranked_leaderboard`, read inside one
 * REPEATABLE READ, READ ONLY transaction so every page of every season comes
 * from the same database snapshot (never a half-published cohort).
 *
 * No Next.js, Supabase-client, Redis, or environment access: the worker passes
 * a pg connection factory, the Meilisearch URL/key and (optionally) fetch.
 */

import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import {
  MEILISEARCH_REBUILD_SEASONS,
  buildMeilisearchCompoundId,
  sortUniqueMeilisearchDocuments,
  type MeilisearchRebuildSeason,
} from './meilisearch-authoritative-rebuild'

export const MEILISEARCH_SYNC_PAGE_SIZE = 1_000
/** A season holds at most 64,000 sealed rows (claim bound). */
export const MEILISEARCH_SYNC_MAX_ROWS_PER_SEASON = 64_000
export const MEILISEARCH_SYNC_UPLOAD_CHUNK = 5_000
const MEILISEARCH_REQUEST_TIMEOUT_MS = 30_000

export interface MeilisearchSyncSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount?: number | null }>
  release(destroy?: boolean): void
}

export interface MeilisearchSyncDependencies {
  connect: () => Promise<MeilisearchSyncSqlClient>
  meiliUrl: string
  meiliAdminKey: string
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

export interface MeilisearchSyncResult {
  ok: true
  traders: number
  seasons: Record<MeilisearchRebuildSeason, number>
  errors: Record<string, never>
}

type PublicRankRow = {
  source: string
  source_trader_id: string
  season_id: string
  handle: string | null
  avatar_url: string | null
  roi: string | number | null
  pnl: string | number | null
  arena_score: string | number | null
  win_rate: string | number | null
  max_drawdown: string | number | null
  followers: string | number | null
  rank: string | number
  trader_type: string | null
  computed_at: string
}

export interface MeilisearchTraderDocument {
  id: string
  handle: string
  platform: string
  platform_name: string
  season_id: MeilisearchRebuildSeason
  roi: number
  pnl: number
  arena_score: number
  win_rate: number | null
  max_drawdown: number | null
  followers: number | null
  rank: number
  trader_type: string | null
  avatar_url: string | null
  updated_at: string
}

const PAGE_SQL = `
SELECT ranked.source, ranked.source_trader_id, ranked.season_id, ranked.handle,
       ranked.avatar_url, ranked.roi, ranked.pnl, ranked.arena_score, ranked.win_rate,
       ranked.max_drawdown, ranked.followers, ranked.rank, ranked.trader_type,
       pg_catalog.to_char(ranked.computed_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS computed_at
  FROM public.public_ranked_leaderboard AS ranked
 WHERE ranked.season_id = $1
   AND ranked.rank > $2
 ORDER BY ranked.rank
 LIMIT $3`

function toNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function toMeilisearchTraderDocument(
  row: PublicRankRow,
  season: MeilisearchRebuildSeason
): MeilisearchTraderDocument {
  if (row.season_id !== season) {
    throw new Error(`public rank row season ${row.season_id} does not match ${season}`)
  }
  const rank = toNumber(row.rank)
  if (rank === null || !Number.isInteger(rank) || rank <= 0) {
    throw new Error(`public rank row ${row.source}:${row.source_trader_id} has no valid rank`)
  }
  return {
    id: buildMeilisearchCompoundId({
      source: row.source,
      source_trader_id: row.source_trader_id,
      season_id: season,
    }),
    handle: row.handle || row.source_trader_id,
    platform: row.source,
    platform_name: EXCHANGE_CONFIG[row.source as keyof typeof EXCHANGE_CONFIG]?.name || row.source,
    season_id: season,
    roi: toNumber(row.roi) ?? 0,
    pnl: toNumber(row.pnl) ?? 0,
    arena_score: toNumber(row.arena_score) ?? 0,
    win_rate: toNumber(row.win_rate),
    max_drawdown: toNumber(row.max_drawdown),
    followers: toNumber(row.followers),
    rank,
    trader_type: row.trader_type,
    avatar_url: row.avatar_url,
    updated_at: row.computed_at,
  }
}

async function meiliRequest(
  deps: MeilisearchSyncDependencies,
  path: string,
  method: 'POST' | 'PUT',
  body: unknown
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const response = await fetchImpl(`${deps.meiliUrl.replace(/\/+$/u, '')}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.meiliAdminKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MEILISEARCH_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Meilisearch ${method} ${path}: ${response.status} ${detail.slice(0, 200)}`)
  }
  return response.json().catch(() => ({}))
}

async function readSeason(
  client: MeilisearchSyncSqlClient,
  season: MeilisearchRebuildSeason
): Promise<MeilisearchTraderDocument[]> {
  const documents: MeilisearchTraderDocument[] = []
  let lastRank = 0
  for (;;) {
    const { rows } = await client.query<PublicRankRow>(PAGE_SQL, [
      season,
      lastRank,
      MEILISEARCH_SYNC_PAGE_SIZE,
    ])
    for (const row of rows) documents.push(toMeilisearchTraderDocument(row, season))
    if (documents.length > MEILISEARCH_SYNC_MAX_ROWS_PER_SEASON) {
      throw new Error(
        `${season}: more than ${MEILISEARCH_SYNC_MAX_ROWS_PER_SEASON} sealed rows; refusing a partial sync`
      )
    }
    if (rows.length < MEILISEARCH_SYNC_PAGE_SIZE) break
    lastRank = documents[documents.length - 1].rank
  }
  return [...sortUniqueMeilisearchDocuments(documents)]
}

/**
 * Upsert every sealed public ranking row of every season into the `traders`
 * index. Throws (so BullMQ retries) when any season fails; never reports a
 * partial sync as success.
 */
export async function syncPublicRankingsToMeilisearch(
  deps: MeilisearchSyncDependencies
): Promise<MeilisearchSyncResult> {
  const log = deps.log ?? (() => undefined)
  if (!deps.meiliUrl || !deps.meiliAdminKey) {
    throw new Error('MEILISEARCH_URL or MEILISEARCH_ADMIN_KEY not configured')
  }

  // 1. One consistent read of the sealed public cohort for all seasons.
  const bySeason = new Map<MeilisearchRebuildSeason, MeilisearchTraderDocument[]>()
  const client = await deps.connect()
  let destroy = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      for (const season of MEILISEARCH_REBUILD_SEASONS) {
        bySeason.set(season, await readSeason(client, season))
      }
      await client.query('COMMIT')
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        destroy = true
        console.error(
          '[meilisearch-sync] ROLLBACK failed; discarding connection:',
          rollbackError instanceof Error ? rollbackError.message : rollbackError
        )
      }
      throw error
    }
  } finally {
    client.release(destroy)
  }

  // 2. Index settings, then documents. Any failure fails the job.
  await meiliRequest(deps, '/indexes/traders/settings/filterable-attributes', 'PUT', [
    'platform',
    'trader_type',
    'arena_score',
    'roi',
    'rank',
    'season_id',
  ])
  const seasons = { '7D': 0, '30D': 0, '90D': 0 } as Record<MeilisearchRebuildSeason, number>
  let traders = 0
  for (const season of MEILISEARCH_REBUILD_SEASONS) {
    const documents = bySeason.get(season) ?? []
    for (let offset = 0; offset < documents.length; offset += MEILISEARCH_SYNC_UPLOAD_CHUNK) {
      await meiliRequest(
        deps,
        '/indexes/traders/documents',
        'POST',
        documents.slice(offset, offset + MEILISEARCH_SYNC_UPLOAD_CHUNK)
      )
    }
    seasons[season] = documents.length
    traders += documents.length
    log(`meilisearch ${season}: ${documents.length} sealed public rows upserted`)
  }
  return { ok: true, traders, seasons, errors: {} }
}
