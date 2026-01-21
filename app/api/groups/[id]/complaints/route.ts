/**
 * 小组投诉 API
 *
 * ⚠️ v2.0 已废弃
 * 此功能已暂停，原因：
 * 1. 使用率极低（<0.1% 用户使用过）
 * 2. 维护成本高
 * 3. 容易被滥用
 *
 * 改用：直接联系客服举报
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// v2.0: 功能已废弃，返回提示信息
const FEATURE_DEPRECATED = true
const DEPRECATION_MESSAGE = {
  zh: '投诉功能已暂停。如需举报，请联系客服。',
  en: 'Complaint feature is temporarily disabled. Please contact support for reports.',
}

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

// 检查并触发投票（当投诉人数达到10%）
async function checkAndTriggerVoting(
  supabase: SupabaseClient<any>,
  complaintId: string,
  groupId: string
) {
  // 获取投诉人数
  const { count: complainantCount } = await supabase
    .from('group_complainants')
    .select('*', { count: 'exact', head: true })
    .eq('complaint_id', complaintId)

  // 获取成员总数
  const memberCount = await getGroupMemberCount(supabase, groupId)

  // 如果投诉人数达到10%，触发投票
  if (complainantCount && memberCount && complainantCount >= Math.ceil(memberCount * 0.1)) {
    const now = new Date()
    const voteEndAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) // 14天后

    await supabase
      .from('group_complaints')
      .update({
        status: 'voting',
        complaint_count: complainantCount,
        vote_started_at: now.toISOString(),
        vote_end_at: voteEndAt.toISOString()
      })
      .eq('id', complaintId)
  } else {
    // 更新投诉人数
    await supabase
      .from('group_complaints')
      .update({ complaint_count: complainantCount })
      .eq('id', complaintId)
  }
}

// 提交投诉
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // v2.0: 功能已废弃
  if (FEATURE_DEPRECATED) {
    const lang = request.headers.get('Accept-Language')?.includes('zh') ? 'zh' : 'en'
    return NextResponse.json(
      { error: DEPRECATION_MESSAGE[lang], deprecated: true },
      { status: 410 } // 410 Gone
    )
  }

  try {
    const { id: groupId } = await params

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
      return NextResponse.json({ error: '只有小组成员可以投诉' }, { status: 403 })
    }

    // 检查小组成员数是否大于100
    const memberCount = await getGroupMemberCount(supabase, groupId)
    if (memberCount <= 100) {
      return NextResponse.json({ error: '投诉功能仅对成员数大于100人的小组开放' }, { status: 403 })
    }

    const body = await request.json()
    const { target_user_id, reason } = body

    // 验证投诉原因长度
    if (!reason || reason.trim().length < 30) {
      return NextResponse.json({ error: '投诉原因至少需要30个字' }, { status: 400 })
    }

    // 检查目标用户角色
    const { data: targetMember } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', target_user_id)
      .maybeSingle()

    if (!targetMember) {
      return NextResponse.json({ error: '目标用户不是小组成员' }, { status: 404 })
    }

    if (targetMember.role !== 'owner' && targetMember.role !== 'admin') {
      return NextResponse.json({ error: '只能投诉组长或管理员' }, { status: 400 })
    }

    // 不能投诉自己
    if (target_user_id === user.id) {
      return NextResponse.json({ error: '不能投诉自己' }, { status: 400 })
    }

    // 检查是否已有进行中的投诉（pending 或 voting）
    const { data: existingComplaint } = await supabase
      .from('group_complaints')
      .select('id, status')
      .eq('group_id', groupId)
      .eq('target_user_id', target_user_id)
      .in('status', ['pending', 'voting'])
      .maybeSingle()

    if (existingComplaint) {
      // 如果已有投诉，检查用户是否已经投诉过
      const { data: existingComplainant } = await supabase
        .from('group_complainants')
        .select('id')
        .eq('complaint_id', existingComplaint.id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (existingComplainant) {
        return NextResponse.json({ error: '您已经投诉过此用户' }, { status: 400 })
      }

      // 添加到投诉人列表
      const { error: addError } = await supabase
        .from('group_complainants')
        .insert({
          complaint_id: existingComplaint.id,
          user_id: user.id,
          reason: reason.trim()
        })

      if (addError) {
        console.error('Add complainant error:', addError)
        return NextResponse.json({ error: '投诉失败' }, { status: 500 })
      }

      // 检查是否需要触发投票
      await checkAndTriggerVoting(supabase, existingComplaint.id, groupId)

      return NextResponse.json({
        success: true,
        message: '投诉已记录',
        complaint_id: existingComplaint.id
      })
    }

    // 创建新的投诉
    const { data: newComplaint, error: createError } = await supabase
      .from('group_complaints')
      .insert({
        group_id: groupId,
        complainant_id: user.id,
        target_user_id,
        target_role: targetMember.role,
        reason: reason.trim(),
        status: 'pending',
        complaint_count: 1
      })
      .select()
      .single()

    if (createError) {
      console.error('Create complaint error:', createError)
      return NextResponse.json({ error: '投诉失败' }, { status: 500 })
    }

    // 添加到投诉人列表
    await supabase
      .from('group_complainants')
      .insert({
        complaint_id: newComplaint.id,
        user_id: user.id,
        reason: reason.trim()
      })

    // 检查是否需要触发投票
    await checkAndTriggerVoting(supabase, newComplaint.id, groupId)

    return NextResponse.json({
      success: true,
      message: '投诉已提交',
      complaint_id: newComplaint.id
    })

  } catch (error) {
    console.error('Complaint error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// 获取进行中的投诉
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // v2.0: 功能已废弃
  if (FEATURE_DEPRECATED) {
    return NextResponse.json({ complaints: [], deprecated: true })
  }

  try {
    const { id: groupId } = await params

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 获取所有进行中的投诉
    const { data: complaints, error } = await supabase
      .from('group_complaints')
      .select(`
        *,
        target_user:user_profiles!group_complaints_target_user_id_fkey(handle, avatar_url)
      `)
      .eq('group_id', groupId)
      .in('status', ['pending', 'voting'])
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Fetch complaints error:', error)
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }

    // 获取成员总数
    const memberCount = await getGroupMemberCount(supabase, groupId)

    // 检查当前用户是否已投诉/投票
    const authHeader = request.headers.get('Authorization')
    let userComplainedIds: string[] = []
    let userVotedIds: string[] = []

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)
      
      if (user) {
        const complaintIds = complaints?.map(c => c.id) || []
        
        if (complaintIds.length > 0) {
          // 检查用户已投诉的
          const { data: complainedData } = await supabase
            .from('group_complainants')
            .select('complaint_id')
            .eq('user_id', user.id)
            .in('complaint_id', complaintIds)
          
          userComplainedIds = complainedData?.map(c => c.complaint_id) || []

          // 检查用户已投票的
          const { data: votedData } = await supabase
            .from('group_complaint_votes')
            .select('complaint_id')
            .eq('user_id', user.id)
            .in('complaint_id', complaintIds)
          
          userVotedIds = votedData?.map(v => v.complaint_id) || []
        }
      }
    }

    return NextResponse.json({
      complaints: complaints?.map(c => ({
        ...c,
        user_complained: userComplainedIds.includes(c.id),
        user_voted: userVotedIds.includes(c.id),
        threshold: Math.ceil(memberCount * 0.1),
        vote_threshold: Math.ceil(memberCount * 0.5)
      })),
      member_count: memberCount
    })

  } catch (error) {
    console.error('Get complaints error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
