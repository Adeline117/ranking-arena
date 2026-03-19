import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// 检查用户是否是小组组长
async function isGroupOwner(
  supabase: SupabaseClient,
  groupId: string, 
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()
  
  return data?.role === 'owner'
}

// 设置成员角色
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId, userId: targetUserId } = await params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // 只有组长可以设置角色
    if (!await isGroupOwner(supabase, groupId, user.id)) {
      return NextResponse.json({ error: 'Only the group owner can set member roles' }, { status: 403 })
    }

    // 不能修改自己的角色
    if (targetUserId === user.id) {
      return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 })
    }

    // 检查目标用户是否是成员
    const { data: memberData } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)
      .maybeSingle()

    if (!memberData) {
      return NextResponse.json({ error: 'Target user is not a group member' }, { status: 404 })
    }

    // 不能修改组长角色
    if (memberData.role === 'owner') {
      return NextResponse.json({ error: 'Cannot change the owner role' }, { status: 400 })
    }

    const body = await request.json()
    const { role } = body

    // 验证角色值
    if (!['admin', 'member'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    // 更新角色
    const { error: updateError } = await supabase
      .from('group_members')
      .update({ role })
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (updateError) {
      logger.error('Set role error:', updateError)
      return NextResponse.json({ error: 'Failed to set role' }, { status: 500 })
    }

    return NextResponse.json({ success: true, role })

  } catch (error: unknown) {
    logger.error('Set role error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
