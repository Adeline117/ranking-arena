import { NextRequest, NextResponse } from 'next/server'
import { createNotification } from '@/lib/data/notifications'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// 管理员/组长向成员发送通知
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId } = await params

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

    // 检查操作者权限
    const { data: operatorMember } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .maybeSingle()

    const operatorRole = operatorMember?.role as string | null
    if (!operatorRole || operatorRole === 'member') {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const body = await request.json()
    const { title, message, target_user_ids } = body as {
      title?: string
      message: string
      target_user_ids?: string[]
    }

    if (!message || message.trim().length === 0) {
      return NextResponse.json({ error: 'Notification content cannot be empty' }, { status: 400 })
    }

    if (message.length > 500) {
      return NextResponse.json({ error: 'Notification content cannot exceed 500 characters' }, { status: 400 })
    }

    // 获取小组名称
    const { data: groupData } = await supabase
      .from('groups')
      .select('name')
      .eq('id', groupId)
      .single()

    const groupName = groupData?.name || 'Group'

    // 获取目标成员列表
    let memberIds: string[] = []

    if (target_user_ids && target_user_ids.length > 0) {
      // 发送给指定成员
      memberIds = target_user_ids.filter(id => id !== user.id)
    } else {
      // 发送给所有成员（排除操作者自己）
      const { data: allMembers } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .neq('user_id', user.id)

      memberIds = (allMembers || []).map(m => m.user_id)
    }

    if (memberIds.length === 0) {
      return NextResponse.json({ error: 'No members to notify' }, { status: 400 })
    }

    const notifyTitle = title?.trim() || `${groupName} admin notification`
    const notifyMessage = message.trim()

    // 批量发送通知和私信
    let successCount = 0
    const errors: string[] = []

    for (const memberId of memberIds) {
      try {
        // 创建系统通知
        await createNotification(supabase, {
          user_id: memberId,
          type: 'system',
          title: notifyTitle,
          message: notifyMessage,
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        })

        // 发送私信
        const orderedUser1 = user.id < memberId ? user.id : memberId
        const orderedUser2 = user.id < memberId ? memberId : user.id

        let conversationId: string | null = null
        const { data: existingConv } = await supabase
          .from('conversations')
          .select('id')
          .eq('user1_id', orderedUser1)
          .eq('user2_id', orderedUser2)
          .maybeSingle()

        if (existingConv) {
          conversationId = existingConv.id
        } else {
          const { data: newConv } = await supabase
            .from('conversations')
            .insert({ user1_id: orderedUser1, user2_id: orderedUser2 })
            .select('id')
            .single()
          conversationId = newConv?.id || null
        }

        if (conversationId) {
          const dmContent = `[${notifyTitle}] ${notifyMessage}`
          await supabase.from('direct_messages').insert({
            conversation_id: conversationId,
            sender_id: user.id,
            receiver_id: memberId,
            content: dmContent.slice(0, 2000),
          })

          await supabase
            .from('conversations')
            .update({
              last_message_at: new Date().toISOString(),
              last_message_preview: dmContent.slice(0, 100)
            })
            .eq('id', conversationId)
        }

        successCount++
      } catch (err: unknown) {
        logger.error(`Failed to notify member ${memberId}:`, err)
        errors.push(memberId)
      }
    }

    return NextResponse.json({
      success: true,
      notified: successCount,
      failed: errors.length,
      total: memberIds.length,
    })

  } catch (error: unknown) {
    logger.error('Group notify error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
