import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getGroupRole, canManageMembers } from '@/lib/services/group-permissions'
import logger from '@/lib/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

type RouteContext = { params: Promise<{ id: string; userId: string }> }

// Ban a user from the group
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id: groupId, userId: targetUserId } = await context.params

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

    // Check actor's role
    const actorRole = await getGroupRole(supabase, user.id, groupId)
    if (!canManageMembers(actorRole)) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // Check target's role - cannot ban the owner
    const targetRole = await getGroupRole(supabase, targetUserId, groupId)
    if (targetRole === 'owner') {
      return NextResponse.json({ error: '不能封禁组长' }, { status: 403 })
    }

    // Admin cannot ban other admins
    if (actorRole === 'admin' && targetRole === 'admin') {
      return NextResponse.json({ error: '管理员不能封禁其他管理员' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const reason = (body as { reason?: string }).reason || null

    // Insert into group_bans table
    const { error: banError } = await supabase
      .from('group_bans')
      .insert({
        group_id: groupId,
        user_id: targetUserId,
        banned_by: user.id,
        reason,
      })

    if (banError) {
      logger.error('Ban insert error:', banError)
      return NextResponse.json({ error: '封禁失败' }, { status: 500 })
    }

    // Soft delete from group_members
    if (targetRole) {
      const { error: deleteError } = await supabase
        .from('group_members')
        .update({ deleted_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)

      if (deleteError) {
        logger.error('Soft delete member error:', deleteError)
      }

      // Decrement member count
      const { error: decrementError } = await supabase.rpc('increment_member_count', {
        p_group_id: groupId,
        p_delta: -1,
      })

      if (decrementError) {
        // Fallback: read-then-write if RPC not available
        const { data: groupData } = await supabase
          .from('groups')
          .select('member_count')
          .eq('id', groupId)
          .single()

        if (groupData) {
          await supabase
            .from('groups')
            .update({ member_count: Math.max(0, (groupData.member_count || 1) - 1) })
            .eq('id', groupId)
        }
      }
    }

    // Log to group_audit_log (fire-and-forget)
    void Promise.resolve(supabase.from('group_audit_log').insert({
      group_id: groupId,
      actor_id: user.id,
      action: 'ban',
      target_id: targetUserId,
      details: { reason }
    })).catch(() => {})

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('Ban user error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// Unban a user from the group
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id: groupId, userId: targetUserId } = await context.params

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

    // Check actor's role
    const actorRole = await getGroupRole(supabase, user.id, groupId)
    if (!canManageMembers(actorRole)) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // Remove from group_bans
    const { error: unbanError } = await supabase
      .from('group_bans')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (unbanError) {
      logger.error('Unban error:', unbanError)
      return NextResponse.json({ error: '解除封禁失败' }, { status: 500 })
    }

    // Log to group_audit_log (fire-and-forget)
    void Promise.resolve(supabase.from('group_audit_log').insert({
      group_id: groupId,
      actor_id: user.id,
      action: 'unban',
      target_id: targetUserId,
      details: {}
    })).catch(() => {})

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('Unban user error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
