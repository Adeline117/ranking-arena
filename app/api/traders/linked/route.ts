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
      .select('id, user_id, trader_id, source, label, is_primary, display_order, verified_at, verification_method, created_at, updated_at')
      .eq('user_id', user.id)
      .order('display_order', { ascending: true })

    if (error) throw error

    if (!linked || linked.length === 0) {
      return success({ linked_traders: [], count: 0 })
    }

    // Batch fetch stats from leaderboard_ranks (avoids N+1 queries)
    const traderKeys = linked.map(lt => lt.trader_id)
    const { data: allRanks } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, source, arena_score, roi, pnl, rank, handle, avatar_url')
      .in('source_trader_id', traderKeys)
      .eq('season_id', '90D')

    const rankMap = new Map<string, typeof allRanks extends (infer T)[] | null ? T : never>()
    for (const r of allRanks || []) {
      rankMap.set(`${r.source}:${r.source_trader_id}`, r)
    }

    const linkedWithStats = linked.map(lt => ({
      ...lt,
      stats: rankMap.get(`${lt.source}:${lt.trader_id}`) || null,
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
    const body = await request.json()

    const { id, label, display_order, is_primary } = body

    if (!id) {
      throw ApiError.validation('Missing linked trader id')
    }

    // Build update object
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (label !== undefined) updateData.label = label
    if (display_order !== undefined) updateData.display_order = display_order

    // If setting as primary, unset all others first (skip the target row to avoid race)
    if (is_primary === true) {
      await supabase
        .from('user_linked_traders')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .neq('id', id)

      updateData.is_primary = true
    } else if (is_primary === false) {
      updateData.is_primary = false
    }

    const { data, error } = await supabase
      .from('user_linked_traders')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error) throw error

    // If primary changed, also update user_profiles
    if (is_primary === true && data) {
      await supabase
        .from('user_profiles')
        .update({
          verified_trader_id: data.trader_id,
          verified_trader_source: data.source,
        })
        .eq('id', user.id)
    }

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
    const body = await request.json()

    const { id } = body
    if (!id) {
      throw ApiError.validation('Missing linked trader id')
    }

    // Get the record first to check if it's primary
    const { data: existing } = await supabase
      .from('user_linked_traders')
      .select('id, trader_id, source, is_primary')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!existing) {
      throw ApiError.notFound('Linked trader not found')
    }

    // Delete the link
    const { error } = await supabase
      .from('user_linked_traders')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) throw error

    // Update count
    const { data: remaining } = await supabase
      .from('user_linked_traders')
      .select('id, is_primary')
      .eq('user_id', user.id)
      .order('display_order', { ascending: true })

    const newCount = remaining?.length ?? 0

    await supabase
      .from('user_profiles')
      .update({ linked_trader_count: newCount })
      .eq('id', user.id)

    // If the deleted one was primary and there are others, promote the first one
    if (existing.is_primary && remaining && remaining.length > 0) {
      const newPrimary = remaining[0]
      await supabase
        .from('user_linked_traders')
        .update({ is_primary: true, updated_at: new Date().toISOString() })
        .eq('id', newPrimary.id)

      // Fetch full record for user_profiles update
      const { data: promoted } = await supabase
        .from('user_linked_traders')
        .select('trader_id, source')
        .eq('id', newPrimary.id)
        .single()

      if (promoted) {
        await supabase
          .from('user_profiles')
          .update({
            verified_trader_id: promoted.trader_id,
            verified_trader_source: promoted.source,
          })
          .eq('id', user.id)
      }
    }

    // If no remaining linked traders, clear verified status
    if (newCount === 0) {
      await supabase
        .from('user_profiles')
        .update({
          is_verified_trader: false,
          verified_trader_id: null,
          verified_trader_source: null,
        })
        .eq('id', user.id)
    }

    logger.info('[linked-traders] Unlinked trader', {
      userId: user.id,
      traderId: existing.trader_id,
      source: existing.source,
    })

    return success({ message: 'Trader unlinked', remaining_count: newCount })
  } catch (error: unknown) {
    return handleError(error, 'linked traders DELETE')
  }
}
