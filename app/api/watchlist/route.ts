/**
 * Trader Watchlist API
 *
 * GET  — list user's watchlist
 * POST — add trader to watchlist
 * DELETE — remove trader from watchlist (via body: { source, source_trader_id })
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError, error as errorResponse } from '@/lib/api/response'
import { ErrorCode } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

const log = createLogger('api:watchlist')
const WATCHLIST_RANKING_PERIOD = '90D'
const PUBLIC_WATCHLIST_RANKING_COLUMNS =
  'source,source_trader_id,roi,pnl,rank,arena_score,win_rate,avatar_url,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

type WatchlistRankingVisibility = 'verified' | 'partial' | 'unknown'

type PublicRankedLeaderboardQueryResult = {
  data: unknown[] | null
  error: { message: string } | null
}

type PublicRankedLeaderboardQuery = PromiseLike<PublicRankedLeaderboardQueryResult> & {
  select(columns: string): PublicRankedLeaderboardQuery
  eq(column: string, value: string): PublicRankedLeaderboardQuery
  in(column: string, values: readonly string[]): PublicRankedLeaderboardQuery
  not(column: string, operator: string, value: null): PublicRankedLeaderboardQuery
  limit(count: number): PublicRankedLeaderboardQuery
}

type PublicRankedLeaderboardClient = {
  from(relation: 'public_ranked_leaderboard'): PublicRankedLeaderboardQuery
}

type PublicWatchlistRankedRow = Record<string, unknown> & {
  source: string
  source_trader_id: string
  rank: number
}

type WatchlistRankingCohort = {
  verifiedByIdentity: Map<string, PublicWatchlistRankedRow[]>
  rawByIdentity: Map<string, number>
  unavailable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicRankedLeaderboardClient(value: unknown): PublicRankedLeaderboardClient {
  // Generated Supabase types lag the additive security-barrier view. This
  // narrow bridge intentionally has no raw-table fallback.
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicRankedLeaderboardClient
}

function watchlistIdentity(source: unknown, traderId: unknown): string | null {
  return typeof source === 'string' &&
    source.length > 0 &&
    typeof traderId === 'string' &&
    traderId.length > 0
    ? `${source}\u0000${traderId}`
    : null
}

function hasPositivePublishedRank(row: unknown): row is PublicWatchlistRankedRow {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    isPublicRankingSourceAllowed(row.source) &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0
  )
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
}

function incrementMapValue(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function buildWatchlistRankingCohort(value: unknown, unavailable = false): WatchlistRankingCohort {
  const rawRows = Array.isArray(value) ? value : []
  const rawByIdentity = new Map<string, number>()
  for (const row of rawRows) {
    if (!isRecord(row)) continue
    const identity = watchlistIdentity(row.source, row.source_trader_id)
    if (identity) incrementMapValue(rawByIdentity, identity)
  }

  const sanitized = sanitizePublicRankingPayload(
    { traders: rawRows, period: WATCHLIST_RANKING_PERIOD },
    { expectedPeriod: WATCHLIST_RANKING_PERIOD }
  ) as { traders?: unknown[] }
  const verifiedByIdentity = new Map<string, PublicWatchlistRankedRow[]>()
  const safeRows = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter(hasPositivePublishedRank)
    : []
  for (const row of safeRows) {
    const identity = watchlistIdentity(row.source, row.source_trader_id)
    if (identity) appendMapValue(verifiedByIdentity, identity, row)
  }

  return { verifiedByIdentity, rawByIdentity, unavailable }
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unknownWatchlistRankingFields(
  item: Record<string, unknown>,
  visibility: WatchlistRankingVisibility,
  reason: string
): Record<string, unknown> {
  return {
    ...item,
    rank: null,
    roi: null,
    pnl: null,
    arena_score: null,
    win_rate: null,
    avatar_url: null,
    ranking_visibility: visibility,
    ranking_visibility_reason: reason,
  }
}

/**
 * Watchlist membership is user-owned identity data. Ranking metrics are a
 * separate published-cohort claim: only an exactly-one, fully sanitized view
 * row may enrich an item. Missing and malformed rows remain actionable but
 * disclose no raw ranking fields.
 */
async function enrichWatchlistWithPublicRankings(
  supabase: unknown,
  watchlist: unknown[]
): Promise<Record<string, unknown>[]> {
  const items = watchlist.filter(isRecord)
  const publicItems = items.filter(
    (item) =>
      typeof item.source === 'string' &&
      isPublicRankingSourceAllowed(item.source) &&
      typeof item.source_trader_id === 'string' &&
      item.source_trader_id.length > 0
  )

  let cohort = buildWatchlistRankingCohort([])
  if (publicItems.length > 0) {
    const sources = [...new Set(publicItems.map((item) => item.source as string))]
    const traderIds = [...new Set(publicItems.map((item) => item.source_trader_id as string))]
    try {
      const { data, error } = await publicRankedLeaderboardClient(supabase)
        .from('public_ranked_leaderboard')
        .select(PUBLIC_WATCHLIST_RANKING_COLUMNS)
        .eq('season_id', WATCHLIST_RANKING_PERIOD)
        .in('source', sources)
        .in('source_trader_id', traderIds)
        .not('rank', 'is', null)
        .limit(200)
      if (error || !Array.isArray(data)) {
        if (error)
          log.warn('Published watchlist ranking cohort unavailable', { error: error.message })
        cohort = buildWatchlistRankingCohort([], true)
      } else {
        cohort = buildWatchlistRankingCohort(data)
      }
    } catch (error) {
      log.warn('Published watchlist ranking cohort unavailable', {
        error: error instanceof Error ? error.message : String(error),
      })
      cohort = buildWatchlistRankingCohort([], true)
    }
  }

  return items.map((item) => {
    const identity = watchlistIdentity(item.source, item.source_trader_id)
    if (
      !identity ||
      typeof item.source !== 'string' ||
      !isPublicRankingSourceAllowed(item.source)
    ) {
      return unknownWatchlistRankingFields(item, 'partial', 'source_not_publicly_rankable')
    }
    if (cohort.unavailable) {
      return unknownWatchlistRankingFields(item, 'unknown', 'public_cohort_unavailable')
    }

    const rawRows = cohort.rawByIdentity.get(identity) ?? 0
    const verifiedRows = cohort.verifiedByIdentity.get(identity) ?? []
    if (rawRows !== 1 || verifiedRows.length !== 1) {
      return unknownWatchlistRankingFields(
        item,
        rawRows > 0 ? 'partial' : 'unknown',
        rawRows > 0 ? 'public_cohort_unverified' : 'public_rank_unavailable'
      )
    }

    const row = verifiedRows[0]
    return {
      ...item,
      rank: row.rank,
      roi: finiteNumberOrNull(row.roi),
      pnl: finiteNumberOrNull(row.pnl),
      arena_score: finiteNumberOrNull(row.arena_score),
      win_rate: finiteNumberOrNull(row.win_rate),
      avatar_url:
        typeof row.avatar_url === 'string' && row.avatar_url.length > 0 ? row.avatar_url : null,
      ranking_visibility: 'verified',
      ranking_visibility_reason: null,
    }
  })
}

/**
 * SCHEMA DRIFT GUARD: the `trader_watchlist` table does NOT exist in prod.
 * The migration `supabase/migrations/20260310000000_add_trader_watchlist.sql`
 * exists in the repo but was never applied to the production database
 * (PostgREST returns PGRST205 "Could not find the table").
 *
 * Until that migration is applied, every method returns 503. Returning an
 * empty GET would falsely tell clients that the user's persisted list is
 * authoritative and empty while writes are unavailable.
 * Restoration = apply the existing migration (table + RLS + indexes), no code
 * changes needed — these guards become dead paths automatically.
 */
function isTableMissing(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    !!err.message?.includes('Could not find the table')
  )
}

function watchlistUnavailable() {
  return errorResponse(
    'Watchlist is temporarily unavailable (feature table missing)',
    503,
    ErrorCode.SERVICE_UNAVAILABLE
  )
}

export const GET = withAuth(
  async ({ user, supabase }) => {
    const { data, error } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      if (isTableMissing(error)) {
        log.warn('trader_watchlist table missing — watchlist reads disabled')
        return watchlistUnavailable()
      }
      log.error('GET query failed', { error: error.message })
      return serverError('Internal server error')
    }

    const watchlist = await enrichWatchlistWithPublicRankings(supabase, data ?? [])

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    // (frontend useWatchlist reads data.watchlist directly)
    return NextResponse.json({ watchlist })
  },
  { name: 'watchlist-list', rateLimit: 'read' }
)

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { source, source_trader_id, handle } = body as {
      source?: string
      source_trader_id?: string
      handle?: string
    }

    if (
      !source ||
      !source_trader_id ||
      typeof source !== 'string' ||
      typeof source_trader_id !== 'string'
    ) {
      return badRequest('source and source_trader_id required (strings)')
    }
    if (source.length > 50 || source_trader_id.length > 200) {
      return badRequest('Invalid input length')
    }

    // Enforce max watchlist size (200)
    // KEEP 'exact' — limit enforcement, scoped per-user via (user_id)
    // index. Must be accurate to block the 201st add.
    const { count, error: countError } = await supabase
      .from('trader_watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    if (countError) {
      if (isTableMissing(countError)) {
        log.warn('trader_watchlist table missing — watchlist writes disabled')
        return watchlistUnavailable()
      }
      // A failed count must not read as "0 items" and skip the size limit.
      log.error('POST size check failed', { error: countError.message })
      return serverError('Internal server error')
    }
    if ((count ?? 0) >= 200) {
      return badRequest('Watchlist full (max 200)')
    }

    const { error } = await supabase.from('trader_watchlist').upsert(
      {
        user_id: user.id,
        source,
        source_trader_id,
        handle: handle || null,
      },
      {
        onConflict: 'user_id,source,source_trader_id',
      }
    )

    if (error) {
      if (isTableMissing(error)) {
        log.warn('trader_watchlist table missing — watchlist writes disabled')
        return watchlistUnavailable()
      }
      log.error('POST upsert failed', { error: error.message })
      return serverError('Internal server error')
    }

    // Return updated watchlist so client can mutate SWR cache immediately
    const { data: updated, error: readError } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (readError) {
      // The client replaces its cache with this list; an empty 200 would
      // un-star every trader. Fail so the hook refetches instead.
      log.error('POST re-read failed', { error: readError.message })
      return serverError('Internal server error')
    }

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    return NextResponse.json({ watchlist: updated ?? [] })
  },
  { name: 'watchlist-add', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { source, source_trader_id } = body as { source?: string; source_trader_id?: string }

    if (!source || !source_trader_id) {
      return badRequest('source and source_trader_id required')
    }

    const { error } = await supabase
      .from('trader_watchlist')
      .delete()
      .eq('user_id', user.id)
      .eq('source', source)
      .eq('source_trader_id', source_trader_id)

    if (error) {
      if (isTableMissing(error)) {
        log.warn('trader_watchlist table missing — watchlist writes disabled')
        return watchlistUnavailable()
      }
      log.error('DELETE failed', { error: error.message })
      return serverError('Internal server error')
    }

    // Return updated watchlist so client can mutate SWR cache immediately
    const { data: updated, error: readError } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (readError) {
      // The client replaces its cache with this list; an empty 200 would
      // un-star every trader. Fail so the hook refetches instead.
      log.error('DELETE re-read failed', { error: readError.message })
      return serverError('Internal server error')
    }

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    return NextResponse.json({ watchlist: updated ?? [] })
  },
  { name: 'watchlist-remove', rateLimit: 'write' }
)
