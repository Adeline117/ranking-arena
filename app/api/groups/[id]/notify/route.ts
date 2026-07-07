import { NextResponse } from 'next/server'
import { createNotification } from '@/lib/data/notifications'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'

/** Extract group id from URL path */
function extractGroupId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('groups')
  return pathParts[idx + 1]
}

// 管理员/组长向成员发送通知
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = extractGroupId(request.url)

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

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { title, message, target_user_ids } = body as {
      title?: string
      message: string
      target_user_ids?: string[]
    }

    if (!message || message.trim().length === 0) {
      return NextResponse.json({ error: 'Notification content cannot be empty' }, { status: 400 })
    }

    if (message.length > 500) {
      return NextResponse.json(
        { error: 'Notification content cannot exceed 500 characters' },
        { status: 400 }
      )
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
      // 发送给指定成员 —— 必须与本群真实成员求交集,绝不信任客户端传入的 id。
      // (安全审计 2026-07-07 P2:否则群管理员可借 target_user_ids 向平台上任意用户
      //  发 DM+通知,绕过对方的 DM 关闭/拉黑/非互关限制。)同样尊重成员自静音。
      const { data: verifiedMembers } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .neq('user_id', user.id)
        .in('user_id', target_user_ids)
        .or('self_notify_muted.is.null,self_notify_muted.eq.false')
      memberIds = (verifiedMembers || []).map((m: { user_id: string }) => m.user_id)
    } else {
      // 发送给所有成员（排除操作者自己 + 自行静音了本群广播的成员）。
      // self_notify_muted 是成员自控偏好（默认 false = 仍接收管理员广播），
      // 见 app/api/groups/[id]/prefs。.or 兼容历史 null 行（列现为 NOT NULL default false）。
      const { data: allMembers } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .neq('user_id', user.id)
        .or('self_notify_muted.is.null,self_notify_muted.eq.false')

      memberIds = (allMembers || []).map((m: { user_id: string }) => m.user_id)
    }

    if (memberIds.length === 0) {
      return NextResponse.json({ error: 'No members to notify' }, { status: 400 })
    }

    const notifyTitle = title?.trim() || `${groupName} admin notification`
    const notifyMessage = message.trim()

    // Batch notify: was N+1 (3-5 DB ops per member × N members = up to 250+ queries for 50 members)
    // Now: 3 batch queries total regardless of member count
    let successCount = 0
    const errors: string[] = []
    const dmContent = `[${notifyTitle}] ${notifyMessage}`

    // 1. Batch create notifications (fire-and-forget with dedup)
    const { sendNotifications } = await import('@/lib/data/notifications')
    sendNotifications(
      supabase,
      memberIds.map((memberId) => ({
        user_id: memberId,
        type: 'system' as const,
        title: notifyTitle,
        message: notifyMessage,
        link: `/groups/${groupId}`,
        actor_id: user.id,
        reference_id: groupId,
      })),
      'group-notify'
    )

    // 2. Pre-fetch all existing conversations in one query
    const convPairs = memberIds.map((memberId) => ({
      user1: user.id < memberId ? user.id : memberId,
      user2: user.id < memberId ? memberId : user.id,
      memberId,
    }))
    const allUser1s = [...new Set(convPairs.map((p) => p.user1))]
    const allUser2s = [...new Set(convPairs.map((p) => p.user2))]
    const { data: existingConvs } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id')
      .in('user1_id', allUser1s)
      .in('user2_id', allUser2s)
    const convMap = new Map<string, string>()
    for (const c of existingConvs || []) {
      convMap.set(`${c.user1_id}:${c.user2_id}`, c.id)
    }

    // 3. Create missing conversations + send DMs
    const now = new Date().toISOString()
    for (const pair of convPairs) {
      try {
        let convId = convMap.get(`${pair.user1}:${pair.user2}`)
        if (!convId) {
          const { data: newConv } = await supabase
            .from('conversations')
            .insert({ user1_id: pair.user1, user2_id: pair.user2 })
            .select('id')
            .single()
          convId = newConv?.id || null
        }
        if (convId) {
          await supabase.from('direct_messages').insert({
            conversation_id: convId,
            sender_id: user.id,
            receiver_id: pair.memberId,
            content: dmContent.slice(0, 2000),
          })
          await supabase
            .from('conversations')
            .update({ last_message_at: now, last_message_preview: dmContent.slice(0, 100) })
            .eq('id', convId)
        }
        successCount++
      } catch (err: unknown) {
        logger.error(`Failed to notify member ${pair.memberId}:`, err)
        errors.push(pair.memberId)
      }
    }

    return NextResponse.json({
      success: true,
      notified: successCount,
      failed: errors.length,
      total: memberIds.length,
    })
  },
  { name: 'groups/notify', rateLimit: 'write' }
)
