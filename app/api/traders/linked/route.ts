/**
 * Linked Traders API
 * GET    /api/traders/linked - List all linked traders for authenticated user
 * PATCH  /api/traders/linked - Update label, display_order, or is_primary
 * DELETE /api/traders/linked - Unlink a trader account
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { invalidateLinkedTraderCache } from '@/lib/data/linked-traders'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function readMutationBody(request: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw ApiError.validation('Request body must be valid JSON')
  }
  if (!isRecord(body)) throw ApiError.validation('Request body must be an object')
  return body
}

function requireLinkedTraderId(body: Record<string, unknown>): string {
  if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
    throw ApiError.validation('Invalid linked trader id')
  }
  return body.id
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>) {
  const unknownFields = Object.keys(body).filter((key) => !allowed.has(key))
  if (unknownFields.length > 0) {
    throw ApiError.validation('Unknown linked trader fields', { fields: unknownFields })
  }
}

function throwRpcError(error: { code?: string; message?: string }): never {
  if (error.code === 'P0002') throw ApiError.notFound('Linked trader not found')
  throw error
}

/**
 * GET /api/traders/linked
 * Return all linked traders for the authenticated user, joined with leaderboard stats
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Get linked traders
    const { data: linked, error } = await supabase
      .from('user_linked_traders')
      .select(
        'id, user_id, trader_id, source, label, is_primary, display_order, verified_at, verification_method, created_at, updated_at'
      )
      .eq('user_id', user.id)
      .order('display_order', { ascending: true })

    if (error) throw error

    if (!linked || linked.length === 0) {
      return success({ linked_traders: [], count: 0 })
    }

    // Batch fetch stats from leaderboard_ranks (avoids N+1 queries)
    const traderKeys = linked.map((linkedTrader) => linkedTrader.trader_id)
    const { data: allRanks, error: ranksError } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, source, arena_score, roi, pnl, rank, handle, avatar_url')
      .in('source_trader_id', traderKeys)
      .eq('season_id', '90D')
    if (ranksError) throw ranksError

    const rankMap = new Map<string, typeof allRanks extends (infer T)[] | null ? T : never>()
    for (const r of allRanks || []) {
      rankMap.set(`${r.source}:${r.source_trader_id}`, r)
    }

    const linkedWithStats = linked.map((linkedTrader) => ({
      ...linkedTrader,
      stats: rankMap.get(`${linkedTrader.source}:${linkedTrader.trader_id}`) || null,
    }))

    return success({
      linked_traders: linkedWithStats,
      count: linkedWithStats.length,
    })
  } catch (error: unknown) {
    return handleError(error, 'linked traders GET')
  }
}

/**
 * PATCH /api/traders/linked
 * Update label, display_order, or is_primary for a linked trader
 *
 * Body: { id: string, label?: string, display_order?: number, is_primary?: boolean }
 */
export async function PATCH(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await readMutationBody(request)
    rejectUnknownFields(body, new Set(['id', 'label', 'display_order', 'is_primary']))
    const id = requireLinkedTraderId(body)
    const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label')
    const hasDisplayOrder = Object.prototype.hasOwnProperty.call(body, 'display_order')
    const hasPrimary = Object.prototype.hasOwnProperty.call(body, 'is_primary')

    if (!hasLabel && !hasDisplayOrder && !hasPrimary) {
      throw ApiError.validation('No linked trader changes supplied')
    }

    if (hasPrimary) {
      if (body.is_primary !== true) {
        throw ApiError.validation('A primary trader can only be changed by selecting a replacement')
      }
      if (hasLabel || hasDisplayOrder) {
        throw ApiError.validation('Primary selection cannot be combined with other updates')
      }

      const { data, error } = await supabase.rpc('set_primary_linked_trader', {
        p_link_id: id,
        p_user_id: user.id,
      })
      if (error) throwRpcError(error)
      if (!data) throw ApiError.notFound('Linked trader not found')
      await invalidateLinkedTraderCache(user.id)
      return success({ linked_trader: data })
    }

    const updateData: { display_order?: number; label?: string | null; updated_at: string } = {
      updated_at: new Date().toISOString(),
    }
    if (hasLabel) {
      if (body.label !== null && typeof body.label !== 'string') {
        throw ApiError.validation('Label must be a string or null')
      }
      const normalizedLabel = typeof body.label === 'string' ? body.label.trim() : null
      if (normalizedLabel && normalizedLabel.length > 50) {
        throw ApiError.validation('Label must be 50 characters or fewer')
      }
      updateData.label = normalizedLabel || null
    }
    if (hasDisplayOrder) {
      if (
        !Number.isInteger(body.display_order) ||
        (body.display_order as number) < 0 ||
        (body.display_order as number) > 10_000
      ) {
        throw ApiError.validation('Display order must be an integer between 0 and 10000')
      }
      updateData.display_order = body.display_order as number
    }

    const { data, error } = await supabase
      .from('user_linked_traders')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle()

    if (error) throw error
    if (!data) throw ApiError.notFound('Linked trader not found')
    await invalidateLinkedTraderCache(user.id)
    return success({ linked_trader: data })
  } catch (error: unknown) {
    return handleError(error, 'linked traders PATCH')
  }
}

/**
 * DELETE /api/traders/linked
 * Unlink a trader account
 *
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await readMutationBody(request)
    rejectUnknownFields(body, new Set(['id']))
    const id = requireLinkedTraderId(body)

    const { data, error } = await supabase.rpc('unlink_linked_trader', {
      p_link_id: id,
      p_user_id: user.id,
    })
    if (error) throwRpcError(error)
    const result = data?.[0]
    if (!result) throw ApiError.notFound('Linked trader not found')

    logger.info('[linked-traders] Unlinked trader', {
      userId: user.id,
      traderId: result.removed_trader_id,
      source: result.removed_source,
    })
    await invalidateLinkedTraderCache(user.id)

    return success({
      message: 'Trader unlinked',
      promoted_link_id: result.promoted_link_id,
      remaining_count: result.remaining_count,
    })
  } catch (error: unknown) {
    return handleError(error, 'linked traders DELETE')
  }
}
