/**
 * User Block/Unblock API
 * POST: Block a user
 * DELETE: Unblock a user
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ handle: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { user, error: authError } = await extractUserFromRequest(request)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const supabase = getSupabaseAdmin()

    const { handle: targetUserId } = await context.params

    if (!targetUserId) {
      return NextResponse.json({ error: 'Target user ID is required' }, { status: 400 })
    }

    // Cannot block yourself
    if (user.id === targetUserId) {
      return NextResponse.json({ error: 'Cannot block yourself' }, { status: 400 })
    }

    // Check if target user exists
    const { data: targetUser, error: targetError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', targetUserId)
      .single()

    if (targetError || !targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Insert block record
    const { error: blockError } = await supabase
      .from('blocked_users')
      .insert({
        blocker_id: user.id,
        blocked_id: targetUserId,
      })

    if (blockError) {
      // Handle duplicate block (already blocked)
      if (blockError.code === '23505') {
        return NextResponse.json({ success: true, alreadyBlocked: true })
      }
      logger.error('[Block User] Insert error:', blockError)
      return NextResponse.json({ error: 'Failed to block user' }, { status: 500 })
    }

    // Cascade: remove mutual follows — await to ensure consistency
    const [removeA, removeB] = await Promise.all([
      supabase.from('user_follows').delete().eq('follower_id', user.id).eq('following_id', targetUserId),
      supabase.from('user_follows').delete().eq('follower_id', targetUserId).eq('following_id', user.id),
    ])
    if (removeA.error) logger.warn('[Block] Failed to remove outgoing follow:', removeA.error.message)
    if (removeB.error) logger.warn('[Block] Failed to remove incoming follow:', removeB.error.message)

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('[Block User] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { user, error: authError } = await extractUserFromRequest(request)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const supabase = getSupabaseAdmin()

    const { handle: targetUserId } = await context.params

    if (!targetUserId) {
      return NextResponse.json({ error: 'Target user ID is required' }, { status: 400 })
    }

    // Delete block record
    const { error: unblockError } = await supabase
      .from('blocked_users')
      .delete()
      .eq('blocker_id', user.id)
      .eq('blocked_id', targetUserId)

    if (unblockError) {
      logger.error('[Unblock User] Delete error:', unblockError)
      return NextResponse.json({ error: 'Failed to unblock user' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('[Unblock User] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
