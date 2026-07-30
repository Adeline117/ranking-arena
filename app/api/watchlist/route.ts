/**
 * Trader Watchlist API
 *
 * GET  — list user's watchlist
 * POST — add trader to watchlist
 * DELETE — remove trader from watchlist (via body: { source, source_trader_id })
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden, serverError, error as errorResponse } from '@/lib/api/response'
import { ErrorCode } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'
import { readSealedRankIdentities } from '@/lib/rankings/read-sealed-rank-identities'

const log = createLogger('api:watchlist')
const WATCHLIST_LIMIT = 200
const sourcePattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const controlCharacterPattern = /[\u0000-\u001f\u007f]/

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
}

interface WatchlistMutationInput {
  source: string
  sourceTraderId: string
  handle: string | null
}

type WatchlistMutationAck =
  | { status: 'invalid' | 'account_inactive' | 'identity_unavailable' }
  | { status: 'limit_reached'; currentCount: number; limit: number }
  | {
      status: 'added' | 'already_present' | 'removed' | 'not_present'
      userId: string
      source: string
      sourceTraderId: string
      currentCount: number
      limit: number
      watchlist: WatchlistItem[]
    }

function rankIdentityKey(source: string, sourceTraderId: string): string {
  return `${source}\u0000${sourceTraderId}`
}

/**
 * SCHEMA DRIFT GUARD: the `trader_watchlist` table has been absent in prod
 * even though its historical migration was recorded.  The atomic authority
 * migration restores the table, policies, and indexes before installing its
 * RPC, but rolling application instances can briefly observe either missing
 * dependency through PostgREST's schema cache.
 *
 * Until that migration is applied, every method returns 503. Returning an
 * empty GET would falsely tell clients that the user's persisted list is
 * authoritative and empty while writes are unavailable.
 * Returning an empty list during that window would falsely overwrite the
 * user's private state, so every missing-dependency form stays unavailable.
 */
function isWatchlistAuthorityUnavailable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return (
    err.code === 'PGRST202' ||
    err.code === 'PGRST205' ||
    err.code === '42883' ||
    err.code === '42P01' ||
    !!err.message?.includes('Could not find the table') ||
    !!err.message?.includes('Could not find the function')
  )
}

function watchlistUnavailable() {
  return errorResponse('Watchlist is temporarily unavailable', 503, ErrorCode.SERVICE_UNAVAILABLE)
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function parseMutationInput(
  value: unknown,
  action: 'add' | 'remove'
): WatchlistMutationInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const source = body.source
  const sourceTraderId = body.source_trader_id

  if (
    typeof source !== 'string' ||
    source.length < 1 ||
    source.length > 50 ||
    source !== source.trim() ||
    source !== source.toLowerCase() ||
    !sourcePattern.test(source) ||
    controlCharacterPattern.test(source) ||
    typeof sourceTraderId !== 'string' ||
    sourceTraderId.length < 1 ||
    sourceTraderId.length > 200 ||
    sourceTraderId !== sourceTraderId.trim() ||
    controlCharacterPattern.test(sourceTraderId)
  ) {
    return null
  }

  const rawHandle = body.handle
  if (action === 'remove') {
    if (rawHandle !== undefined && rawHandle !== null) return null
    return { source, sourceTraderId, handle: null }
  }

  if (rawHandle === undefined || rawHandle === null) {
    return { source, sourceTraderId, handle: null }
  }
  if (
    typeof rawHandle !== 'string' ||
    rawHandle.length < 1 ||
    rawHandle.length > 200 ||
    rawHandle !== rawHandle.trim() ||
    controlCharacterPattern.test(rawHandle)
  ) {
    return null
  }
  return { source, sourceTraderId, handle: rawHandle }
}

function isWatchlistItem(value: unknown): value is WatchlistItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    exactKeys(item, ['source', 'source_trader_id', 'handle', 'created_at']) &&
    typeof item.source === 'string' &&
    item.source.length > 0 &&
    typeof item.source_trader_id === 'string' &&
    item.source_trader_id.length > 0 &&
    (item.handle === null || typeof item.handle === 'string') &&
    typeof item.created_at === 'string' &&
    item.created_at.length > 0
  )
}

function parseMutationAck(value: unknown): WatchlistMutationAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (
    exactKeys(result, ['status']) &&
    (result.status === 'invalid' ||
      result.status === 'account_inactive' ||
      result.status === 'identity_unavailable')
  ) {
    return { status: result.status }
  }

  if (
    exactKeys(result, ['status', 'current_count', 'limit']) &&
    result.status === 'limit_reached' &&
    result.current_count === WATCHLIST_LIMIT &&
    result.limit === WATCHLIST_LIMIT
  ) {
    return {
      status: 'limit_reached',
      currentCount: WATCHLIST_LIMIT,
      limit: WATCHLIST_LIMIT,
    }
  }

  if (
    !exactKeys(result, [
      'status',
      'user_id',
      'source',
      'source_trader_id',
      'current_count',
      'limit',
      'watchlist',
    ]) ||
    !['added', 'already_present', 'removed', 'not_present'].includes(String(result.status)) ||
    typeof result.user_id !== 'string' ||
    result.user_id.length < 1 ||
    typeof result.source !== 'string' ||
    result.source.length < 1 ||
    typeof result.source_trader_id !== 'string' ||
    result.source_trader_id.length < 1 ||
    !Number.isSafeInteger(result.current_count) ||
    Number(result.current_count) < 0 ||
    Number(result.current_count) > WATCHLIST_LIMIT ||
    result.limit !== WATCHLIST_LIMIT ||
    !Array.isArray(result.watchlist) ||
    result.watchlist.length !== result.current_count ||
    !result.watchlist.every(isWatchlistItem)
  ) {
    return null
  }

  return {
    status: result.status as 'added' | 'already_present' | 'removed' | 'not_present',
    userId: result.user_id,
    source: result.source,
    sourceTraderId: result.source_trader_id,
    currentCount: Number(result.current_count),
    limit: WATCHLIST_LIMIT,
    watchlist: result.watchlist,
  }
}

function mutationResponse(
  rawAck: unknown,
  mutationError: { code?: string; message?: string } | null,
  expected: WatchlistMutationInput & { action: 'add' | 'remove'; userId: string }
) {
  if (mutationError) {
    if (isWatchlistAuthorityUnavailable(mutationError)) {
      log.warn('Atomic watchlist authority unavailable', {
        action: expected.action,
        code: mutationError.code,
      })
      return watchlistUnavailable()
    }
    log.error('Atomic watchlist mutation failed', {
      action: expected.action,
      code: mutationError.code,
      error: mutationError.message,
      userId: expected.userId,
    })
    return serverError('Internal server error')
  }

  const ack = parseMutationAck(rawAck)
  if (!ack) {
    log.error('Atomic watchlist mutation returned an invalid acknowledgement', {
      action: expected.action,
      userId: expected.userId,
    })
    return serverError('Internal server error')
  }
  if (ack.status === 'account_inactive') {
    return forbidden('Account is inactive')
  }
  if (ack.status === 'identity_unavailable') {
    if (expected.action !== 'add') {
      log.error('Atomic watchlist mutation returned identity denial for remove')
      return serverError('Internal server error')
    }
    return badRequest('Trader identity is unavailable')
  }
  if (ack.status === 'invalid') {
    log.error('Atomic watchlist policy rejected validated input', {
      action: expected.action,
      userId: expected.userId,
    })
    return serverError('Internal server error')
  }
  if (ack.status === 'limit_reached') {
    if (expected.action !== 'add') {
      log.error('Atomic watchlist mutation returned a limit for remove')
      return serverError('Internal server error')
    }
    return badRequest(`Watchlist full (max ${ack.limit})`)
  }
  if (!('userId' in ack)) {
    log.error('Atomic watchlist mutation returned an unhandled denial', {
      action: expected.action,
      status: ack.status,
    })
    return serverError('Internal server error')
  }

  const statusMatchesAction =
    expected.action === 'add'
      ? ack.status === 'added' || ack.status === 'already_present'
      : ack.status === 'removed' || ack.status === 'not_present'
  if (
    !statusMatchesAction ||
    ack.userId !== expected.userId ||
    ack.source !== expected.source ||
    ack.sourceTraderId !== expected.sourceTraderId
  ) {
    log.error('Atomic watchlist acknowledgement did not match its request', {
      action: expected.action,
      status: ack.status,
      userId: expected.userId,
    })
    return serverError('Internal server error')
  }

  return NextResponse.json({ watchlist: ack.watchlist })
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
      if (isWatchlistAuthorityUnavailable(error)) {
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
  async ({ user, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const input = parseMutationInput(body, 'add')
    if (!input) return badRequest('Invalid watchlist identity')

    const userSupabase = createUserScopedServerClient(request)
    const { data, error } = await userSupabase.rpc('mutate_trader_watchlist_atomic', {
      p_source: input.source,
      p_source_trader_id: input.sourceTraderId,
      p_handle: input.handle,
      p_action: 'add',
    })

    return mutationResponse(data, error, {
      ...input,
      action: 'add',
      userId: user.id,
    })
  },
  { name: 'watchlist-add', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const input = parseMutationInput(body, 'remove')
    if (!input) return badRequest('Invalid watchlist identity')

    const userSupabase = createUserScopedServerClient(request)
    const { data, error } = await userSupabase.rpc('mutate_trader_watchlist_atomic', {
      p_source: input.source,
      p_source_trader_id: input.sourceTraderId,
      p_handle: null,
      p_action: 'remove',
    })

    return mutationResponse(data, error, {
      ...input,
      action: 'remove',
      userId: user.id,
    })
  },
  { name: 'watchlist-remove', rateLimit: 'write' }
)
