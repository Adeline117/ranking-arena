import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: groupId } = await params
    const body = await request.json()
    const { action } = body as { action: 'join' | 'leave' }

    if (!action || !['join', 'leave'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Verify group exists
    const { data: group, error: groupErr } = await supabase
      .from('groups')
      .select('id, created_by, is_premium_only')
      .eq('id', groupId)
      .maybeSingle()

    if (groupErr || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    if (action === 'join') {
      // Check if already a member
      const { data: existing } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (existing) {
        return NextResponse.json({ error: 'Already a member' }, { status: 409 })
      }

      const { error: insertErr } = await supabase
        .from('group_members')
        .insert({ group_id: groupId, user_id: user.id, role: 'member' })

      if (insertErr) {
        logger.error('Join group error:', insertErr)
        return NextResponse.json({ error: 'Failed to join' }, { status: 500 })
      }

      await supabase.rpc('increment_member_count', { p_group_id: groupId, p_delta: 1 })

      // Notify owner
      if (group.created_by && group.created_by !== user.id) {
        await supabase.from('notifications').insert({
          user_id: group.created_by,
          type: 'system',
          title: 'New member joined',
          message: 'A new member has joined your group',
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        })
      }

      return NextResponse.json({ success: true, action: 'joined' })
    }

    if (action === 'leave') {
      // Cannot leave if owner
      if (group.created_by === user.id) {
        return NextResponse.json({ error: 'Owner cannot leave the group' }, { status: 403 })
      }

      const { error: deleteErr } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', user.id)

      if (deleteErr) {
        logger.error('Leave group error:', deleteErr)
        return NextResponse.json({ error: 'Failed to leave' }, { status: 500 })
      }

      await supabase.rpc('increment_member_count', { p_group_id: groupId, p_delta: -1 })

      return NextResponse.json({ success: true, action: 'left' })
    }
  } catch (err) {
    logger.error('Membership API error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
