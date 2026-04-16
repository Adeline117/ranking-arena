import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import { createNotification } from '@/lib/data/notifications'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

// 检查用户是否是小组管理员或组长
async function getGroupRole(
  supabase: SupabaseClient,
  groupId: string,
  userId: string
): Promise<'owner' | 'admin' | 'member' | null> {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()

  return data?.role as 'owner' | 'admin' | 'member' | null
}

// 禁言成员
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: groupId, userId: targetUserId } = await params

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      // 检查操作者权限
      const operatorRole = await getGroupRole(supabase, groupId, user.id)
      if (!operatorRole || operatorRole === 'member') {
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      }

      // 检查目标用户角色
      const targetRole = await getGroupRole(supabase, groupId, targetUserId)
      if (!targetRole) {
        return NextResponse.json({ error: 'Target user is not a group member' }, { status: 404 })
      }

      // 管理员不能禁言组长或其他管理员
      if (operatorRole === 'admin' && (targetRole === 'owner' || targetRole === 'admin')) {
        return NextResponse.json({ error: 'No permission to mute this user' }, { status: 403 })
      }

      // 组长不能禁言自己
      if (operatorRole === 'owner' && targetUserId === user.id) {
        return NextResponse.json({ error: 'Cannot mute yourself' }, { status: 400 })
      }

      let body: { muted_until?: string | null; reason?: string | null }
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
      const { muted_until, reason } = body

      // 更新禁言状态
      const { error: updateError } = await supabase
        .from('group_members')
        .update({
          muted_until,
          mute_reason: reason || null,
          muted_by: user.id,
        })
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)

      if (updateError) {
        logger.error('Mute error:', updateError)
        return NextResponse.json({ error: 'Mute failed' }, { status: 500 })
      }

      // 发送私信通知给被禁言用户
      try {
        // 获取小组名称
        const { data: groupData } = await supabase
          .from('groups')
          .select('name')
          .eq('id', groupId)
          .single()

        const groupName = groupData?.name || 'Group'

        // 格式化禁言时长
        let durationText = ''
        if (muted_until) {
          const mutedDate = new Date(muted_until)
          const now = new Date()
          const diffMs = mutedDate.getTime() - now.getTime()
          const diffHours = Math.round(diffMs / (1000 * 60 * 60))
          if (diffHours <= 4) durationText = '3 hours'
          else if (diffHours <= 25) durationText = '1 day'
          else if (diffHours <= 170) durationText = '7 days'
          else durationText = 'permanently'
        }

        const reasonText = reason ? `\nReason: ${reason}` : ''
        const messageContent = `You have been muted in "${groupName}" for ${durationText}. ${reasonText}`

        // 创建或获取会话并发送私信
        const orderedUser1 = user.id < targetUserId ? user.id : targetUserId
        const orderedUser2 = user.id < targetUserId ? targetUserId : user.id

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
          await supabase.from('direct_messages').insert({
            conversation_id: conversationId,
            sender_id: user.id,
            receiver_id: targetUserId,
            content: messageContent,
          })

          // 更新会话最后消息时间
          await supabase
            .from('conversations')
            .update({
              last_message_at: new Date().toISOString(),
              last_message_preview: messageContent.slice(0, 100),
            })
            .eq('id', conversationId)
        }

        // 同时创建系统通知
        await createNotification(supabase, {
          user_id: targetUserId,
          type: 'system',
          title: 'Group mute notification',
          message: messageContent,
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        })
      } catch (notifyError) {
        // 通知发送失败不影响禁言操作
        logger.error('Failed to send mute notification:', notifyError)
      }

      // Audit log (fire-and-forget)
      const duration = muted_until || 'permanent'
      fireAndForget(
        supabase.from('group_audit_log').insert({
          group_id: groupId,
          actor_id: user.id,
          action: 'mute',
          target_id: targetUserId,
          details: { duration, reason: reason || null },
        }).then(),
        'Group audit log: mute'
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-mute', rateLimit: 'write' }
  )

  return handler(request)
}

// 解除禁言
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: groupId, userId: targetUserId } = await params

  const handler = withAuth(
    async ({ user, supabase }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      // 检查操作者权限
      const operatorRole = await getGroupRole(supabase, groupId, user.id)
      if (!operatorRole || operatorRole === 'member') {
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      }

      // 解除禁言
      const { error: updateError } = await supabase
        .from('group_members')
        .update({
          muted_until: null,
          mute_reason: null,
          muted_by: null,
        })
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)

      if (updateError) {
        logger.error('Unmute error:', updateError)
        return NextResponse.json({ error: 'Failed to unmute' }, { status: 500 })
      }

      // Audit log (fire-and-forget)
      fireAndForget(
        supabase.from('group_audit_log').insert({
          group_id: groupId,
          actor_id: user.id,
          action: 'unmute',
          target_id: targetUserId,
          details: {},
        }).then(),
        'Group audit log: unmute'
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-unmute', rateLimit: 'write' }
  )

  return handler(request)
}
