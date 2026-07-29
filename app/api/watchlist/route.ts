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
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { readSealedRankIdentities } from '@/lib/rankings/read-sealed-rank-identities'

const log = createLogger('api:watchlist')

function rankIdentityKey(source: string, sourceTraderId: string): string {
  return `${source}\u0000${sourceTraderId}`
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

    const watchlist = data || []

    // Enrich watchlist items with leaderboard snapshot data (ROI, PnL, rank, arena_score)
    if (watchlist.length > 0) {
      try {
        // Publication proofs are service-role only. The private watchlist edge
        // query above remains scoped by the authenticated client; only its
        // exact composite identities are passed to this bounded enrichment.
        const sealedRead = await readSealedRankIdentities(
          getSupabaseAdmin(),
          '90D',
          watchlist.map((item) => ({
            source: item.source,
            sourceTraderId: item.source_trader_id,
          }))
        )
        const rankMap = new Map(
          (sealedRead?.value ?? []).map((rank) => [
            rankIdentityKey(rank.source, rank.source_trader_id),
            rank,
          ])
        )
        for (const item of watchlist) {
          const key = rankIdentityKey(item.source, item.source_trader_id)
          const rank = rankMap.get(key)
          if (rank) {
            Object.assign(item, {
              roi: rank.roi,
              pnl: rank.pnl,
              rank: rank.rank,
              arena_score: rank.arena_score,
              win_rate: rank.win_rate,
              avatar_url: rank.avatar_url,
            })
          }
        }
      } catch (rankError) {
        log.error('GET sealed rank enrichment failed', {
          error: rankError instanceof Error ? rankError.message : String(rankError),
        })
        return serverError('Internal server error')
      }
    }

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
    const { count } = await supabase
      .from('trader_watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
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
    const { data: updated } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

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
    const { data: updated } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    return NextResponse.json({ watchlist: updated ?? [] })
  },
  { name: 'watchlist-remove', rateLimit: 'write' }
)
