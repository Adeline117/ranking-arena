/**
 * POST /api/groups/[id]/dissolve
 *
 * Dissolves a group. Only the owner can do this.
 * Sets dissolved_at = now(). After dissolution:
 * - Historical posts remain readable
 * - No new posts, joins, or member management
 * - Group disappears from owner's sidebar
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const rl = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rl) return rl

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: groupId } = await context.params
    const supabase = getSupabaseAdmin()

    // Verify group exists and user is owner
    const { data: group, error: groupError } = await supabase
      .from('groups')
      .select('id, created_by, name, dissolved_at')
      .eq('id', groupId)
      .maybeSingle()

    if (groupError || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    if (group.created_by !== user.id) {
      return NextResponse.json({ error: 'Only the group owner can dissolve the group' }, { status: 403 })
    }

    if (group.dissolved_at) {
      return NextResponse.json({ error: 'Group is already dissolved' }, { status: 400 })
    }

    // Dissolve: set dissolved_at
    const { error: updateError } = await supabase
      .from('groups')
      .update({ dissolved_at: new Date().toISOString() })
      .eq('id', groupId)

    if (updateError) {
      logger.error('[dissolve] Failed to dissolve group:', updateError)
      return NextResponse.json({ error: 'Failed to dissolve group' }, { status: 500 })
    }

    logger.info(`[dissolve] Group "${group.name}" (${groupId}) dissolved by ${user.id}`)

    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[dissolve] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
