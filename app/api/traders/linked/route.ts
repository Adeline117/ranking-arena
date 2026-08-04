/**
 * Linked Traders API
 * GET    /api/traders/linked - List exact linked identities for authenticated user
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
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

interface LinkedTraderSingleRowRpcBuilder {
  single(): Promise<{
    data: Record<string, unknown> | null
    error: { code?: string; message?: string } | null
  }>
}

interface LinkedTraderMutationRpcClient {
  rpc(
    functionName: 'set_primary_linked_trader_v2',
    args: {
      p_user_id: string
      p_link_id: string
    }
  ): LinkedTraderSingleRowRpcBuilder
  rpc(
    functionName: 'update_linked_trader_metadata_v1',
    args: {
      p_user_id: string
      p_link_id: string
      p_update_label: boolean
      p_label: string | null
      p_update_display_order: boolean
      p_display_order: number | null
    }
  ): LinkedTraderSingleRowRpcBuilder
  rpc(
    functionName: 'unlink_linked_trader_v2',
    args: {
      p_user_id: string
      p_link_id: string
    }
  ): Promise<{
    data: Array<{
      remaining_count: number
      removed_trader_id: string
      removed_source: string
      promoted_link_id: string | null
    }> | null
    error: { code?: string; message?: string } | null
  }>
}

function withPrivateNoStore<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

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
 * Return all linked traders for the authenticated user.
 *
 * This management boundary intentionally does not project leaderboard numerics.
 * `leaderboard_ranks` rows do not carry the publication/completeness and Money
 * provenance required to authorize a score, rank, ROI, or cross-source PnL here.
 * Callers receive `stats: null` until a request-bound serving projection exists.
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Get linked traders
    const { data: linked, error } = await supabase
      .from('user_linked_traders')
      .select(
        'id, user_id, trader_id, source, label, is_primary, display_order, verified_at, verification_method'
      )
      .eq('user_id', user.id)
      .order('display_order', { ascending: true })

    if (error) throw error

    if (!linked || linked.length === 0) {
      return withPrivateNoStore(success({ linked_traders: [], count: 0 }))
    }

    const linkedWithUnknownStats = linked.map((linkedTrader) => ({
      id: linkedTrader.id,
      user_id: linkedTrader.user_id,
      trader_id: linkedTrader.trader_id,
      source: linkedTrader.source,
      label: linkedTrader.label?.trim() || null,
      is_primary: linkedTrader.is_primary,
      verified_at: linkedTrader.verified_at,
      verification_method: linkedTrader.verification_method,
      stats: null,
    }))

    return withPrivateNoStore(
      success({
        linked_traders: linkedWithUnknownStats,
        count: linkedWithUnknownStats.length,
      })
    )
  } catch (error: unknown) {
    return withPrivateNoStore(handleError(error, 'linked traders GET'))
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
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

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

      const mutationRpc = supabase as unknown as LinkedTraderMutationRpcClient
      const { data, error } = await mutationRpc
        .rpc('set_primary_linked_trader_v2', {
          p_link_id: id,
          p_user_id: user.id,
        })
        .single()
      if (error) throwRpcError(error)
      if (!data) throw ApiError.notFound('Linked trader not found')
      await invalidateLinkedTraderCache(user.id)
      return withPrivateNoStore(success({ linked_trader: data }))
    }

    let normalizedLabel: string | null = null
    if (hasLabel) {
      if (body.label !== null && typeof body.label !== 'string') {
        throw ApiError.validation('Label must be a string or null')
      }
      normalizedLabel = typeof body.label === 'string' ? body.label.trim() : null
      if (normalizedLabel && normalizedLabel.length > 50) {
        throw ApiError.validation('Label must be 50 characters or fewer')
      }
      normalizedLabel = normalizedLabel || null
    }
    if (hasDisplayOrder) {
      if (
        !Number.isInteger(body.display_order) ||
        (body.display_order as number) < 0 ||
        (body.display_order as number) > 10_000
      ) {
        throw ApiError.validation('Display order must be an integer between 0 and 10000')
      }
    }

    // Phase B removes service-role table DML so immutable deployments cannot
    // bypass unlink/primary invariants. Metadata edits use the only narrow,
    // owner-scoped definer RPC instead of a direct table update.
    const mutationRpc = supabase as unknown as LinkedTraderMutationRpcClient
    const { data, error } = await mutationRpc
      .rpc('update_linked_trader_metadata_v1', {
        p_user_id: user.id,
        p_link_id: id,
        p_update_label: hasLabel,
        p_label: hasLabel ? normalizedLabel : null,
        p_update_display_order: hasDisplayOrder,
        p_display_order: hasDisplayOrder ? (body.display_order as number) : null,
      })
      .single()

    if (error) throwRpcError(error)
    if (!data) throw ApiError.notFound('Linked trader not found')
    await invalidateLinkedTraderCache(user.id)
    return withPrivateNoStore(success({ linked_trader: data }))
  } catch (error: unknown) {
    return withPrivateNoStore(handleError(error, 'linked traders PATCH'))
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
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await readMutationBody(request)
    rejectUnknownFields(body, new Set(['id']))
    const id = requireLinkedTraderId(body)

    const mutationRpc = supabase as unknown as LinkedTraderMutationRpcClient
    const { data, error } = await mutationRpc.rpc('unlink_linked_trader_v2', {
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

    return withPrivateNoStore(
      success({
        message: 'Trader unlinked',
        promoted_link_id: result.promoted_link_id,
        remaining_count: result.remaining_count,
      })
    )
  } catch (error: unknown) {
    return withPrivateNoStore(handleError(error, 'linked traders DELETE'))
  }
}
