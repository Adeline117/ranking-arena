import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

type RouteContext = { params: Promise<{ id: string; userId: string }> }

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

    // Cannot kick yourself
    if (user.id === targetUserId) {
      return NextResponse.json({ error: '不能踢出自己' }, { status: 400 })
    }

    // Check requester's role
    const { data: requesterMembership } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!requesterMembership || (requesterMembership.role !== 'owner' && requesterMembership.role !== 'admin')) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // Check target's role
    const { data: targetMembership } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)
      .maybeSingle()

    if (!targetMembership) {
      return NextResponse.json({ error: '该用户不是小组成员' }, { status: 404 })
    }

    // Owner can kick anyone except self (already checked); admin can only kick members
    if (requesterMembership.role === 'admin' && targetMembership.role !== 'member') {
      return NextResponse.json({ error: '管理员只能踢出普通成员' }, { status: 403 })
    }

    // Cannot kick the owner
    if (targetMembership.role === 'owner') {
      return NextResponse.json({ error: '不能踢出组长' }, { status: 403 })
    }

    // Remove from group_members
    const { error: deleteError } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (deleteError) {
      console.error('Kick member error:', deleteError)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }

    // Atomically decrement member_count to avoid race conditions
    const { error: decrementError } = await supabase.rpc('increment_member_count', {
      p_group_id: groupId,
      p_delta: -1,
    })

    if (decrementError) {
      // Fallback: read-then-write if RPC not available
      const { data: groupData, error: groupError } = await supabase
        .from('groups')
        .select('member_count')
        .eq('id', groupId)
        .single()

      if (groupError) {
        console.error('Failed to fetch group for member_count update:', groupError)
      } else if (groupData) {
        await supabase
          .from('groups')
          .update({ member_count: Math.max(0, (groupData.member_count || 1) - 1) })
          .eq('id', groupId)
      }
    }

    // Send notification to kicked user
    const { error: notifyError } = await supabase
      .from('notifications')
      .insert({
        user_id: targetUserId,
        type: 'system',
        title: '您已被移出小组',
        message: `您已被管理员移出小组`,
        link: `/groups/${groupId}`,
        actor_id: user.id,
        reference_id: groupId,
      })

    if (notifyError) {
      console.error('Failed to send kick notification:', notifyError)
    }

    // Audit log (fire-and-forget)
    void Promise.resolve(supabase.from('group_audit_log').insert({
      group_id: groupId,
      actor_id: user.id,
      action: 'kick',
      target_id: targetUserId,
      details: { reason: null }
    })).catch(() => {})

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Kick member error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
