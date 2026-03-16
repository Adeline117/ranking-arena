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
      .select('*')
      .eq('user_id', user.id)
      .order('display_order', { ascending: true })

    if (error) throw error

    if (!linked || linked.length === 0) {
      return success({ linked_traders: [], count: 0 })
    }

    // Fetch current stats from leaderboard_ranks for each linked trader
    const statsPromises = linked.map(async (lt) => {
      const { data: rank } = await supabase
        .from('leaderboard_ranks')
        .select('arena_score, roi, pnl, rank, handle, avatar_url')
        .eq('trader_key', lt.trader_id)
        .eq('platform', lt.source)
        .maybeSingle()

      return {
        ...lt,
        stats: rank || null,
      }
    })

    const linkedWithStats = await Promise.all(statsPromises)

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
      return handleError(new Error('Missing linked trader id'), 'linked traders PATCH')
    }

    // Build update object
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (label !== undefined) updateData.label = label
    if (display_order !== undefined) updateData.display_order = display_order

    // If setting as primary, unset all others first
    if (is_primary === true) {
      await supabase
        .from('user_linked_traders')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)

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
      return handleError(new Error('Missing linked trader id'), 'linked traders DELETE')
    }

    // Get the record first to check if it's primary
    const { data: existing } = await supabase
      .from('user_linked_traders')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!existing) {
      return handleError(new Error('Linked trader not found'), 'linked traders DELETE')
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
