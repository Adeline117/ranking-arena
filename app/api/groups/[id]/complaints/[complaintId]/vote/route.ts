import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查用户是否是小组成员
async function isGroupMember(
  supabase: SupabaseClient<any>, 
  groupId: string, 
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()
  
  return !!data
}

// 获取小组成员数
async function getGroupMemberCount(
  supabase: SupabaseClient<any>,
  groupId: string
): Promise<number> {
  const { count } = await supabase
    .from('group_members')
    .select('*', { count: 'exact', head: true })
    .eq('group_id', groupId)
  
  return count || 0
}

// 检查投票结果并处理
async function checkAndResolveComplaint(
  supabase: SupabaseClient<any>,
  complaintId: string,
  groupId: string
) {
  // 获取投诉信息
  const { data: complaint } = await supabase
    .from('group_complaints')
    .select('*')
    .eq('id', complaintId)
    .single()

  if (!complaint || complaint.status !== 'voting') return

  // 检查是否过期
  const now = new Date()
  const voteEndAt = new Date(complaint.vote_end_at)
  
  if (now < voteEndAt) return // 投票还未结束

  // 获取成员总数
  const memberCount = await getGroupMemberCount(supabase, groupId)
  const threshold = Math.ceil(memberCount * 0.5)

  // 判断投票结果
  if (complaint.votes_for >= threshold) {
    // 投诉成功，解除组长/管理员职务
    await supabase
      .from('group_members')
      .update({ role: 'member' })
      .eq('group_id', groupId)
      .eq('user_id', complaint.target_user_id)

    // 如果被投诉的是组长，标记小组无组长状态
    if (complaint.target_role === 'owner') {
      await supabase
        .from('groups')
        .update({ has_owner: false })
        .eq('id', groupId)

      // 创建组长竞选
      await supabase
        .from('group_leader_elections')
        .insert({
          group_id: groupId,
          status: 'open'
        })
    }

    // 更新投诉状态
    await supabase
      .from('group_complaints')
      .update({
        status: 'resolved',
        resolved_at: now.toISOString()
      })
      .eq('id', complaintId)

    // 发送通知
    await supabase
      .from('notifications')
      .insert({
        user_id: complaint.target_user_id,
        type: 'system',
        title: '投诉投票结果',
        message: '由于投诉投票通过，您的管理员身份已被撤销。',
        link: `/groups/${groupId}`
      })
  } else {
    // 投诉失败
    await supabase
      .from('group_complaints')
      .update({
        status: 'dismissed',
        resolved_at: now.toISOString()
      })
      .eq('id', complaintId)
  }
}

// 投票
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; complaintId: string }> }
) {
  try {
    const { id: groupId, complaintId } = await params
    
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

    // 检查是否是成员
    if (!await isGroupMember(supabase, groupId, user.id)) {
      return NextResponse.json({ error: '只有小组成员可以投票' }, { status: 403 })
    }

    // 获取投诉信息
    const { data: complaint } = await supabase
      .from('group_complaints')
      .select('*')
      .eq('id', complaintId)
      .eq('group_id', groupId)
      .single()

    if (!complaint) {
      return NextResponse.json({ error: '投诉不存在' }, { status: 404 })
    }

    if (complaint.status !== 'voting') {
      return NextResponse.json({ error: '投诉未在投票阶段' }, { status: 400 })
    }

    // 检查投票是否已过期
    const now = new Date()
    const voteEndAt = new Date(complaint.vote_end_at)
    if (now > voteEndAt) {
      // 检查并处理结果
      await checkAndResolveComplaint(supabase, complaintId, groupId)
      return NextResponse.json({ error: '投票已结束' }, { status: 400 })
    }

    // 检查是否已投票
    const { data: existingVote } = await supabase
      .from('group_complaint_votes')
      .select('id')
      .eq('complaint_id', complaintId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingVote) {
      return NextResponse.json({ error: '您已经投票过了' }, { status: 400 })
    }

    const body = await request.json()
    const { vote } = body // true = 支持投诉, false = 反对投诉

    if (typeof vote !== 'boolean') {
      return NextResponse.json({ error: '无效的投票' }, { status: 400 })
    }

    // 投票
    const { error: voteError } = await supabase
      .from('group_complaint_votes')
      .insert({
        complaint_id: complaintId,
        user_id: user.id,
        vote
      })

    if (voteError) {
      console.error('Vote error:', voteError)
      return NextResponse.json({ error: '投票失败' }, { status: 500 })
    }

    // 获取最新投票统计（触发器会自动更新）
    const { data: updatedComplaint } = await supabase
      .from('group_complaints')
      .select('votes_for, votes_against')
      .eq('id', complaintId)
      .single()

    return NextResponse.json({
      success: true,
      votes_for: updatedComplaint?.votes_for || 0,
      votes_against: updatedComplaint?.votes_against || 0
    })

  } catch (error) {
    console.error('Vote error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
