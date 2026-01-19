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

// 检查并结束选举
async function checkAndCloseElection(
  supabase: SupabaseClient<any>,
  electionId: string,
  groupId: string
) {
  const { data: election } = await supabase
    .from('group_leader_elections')
    .select('*')
    .eq('id', electionId)
    .single()

  if (!election || election.status !== 'voting') return

  const now = new Date()
  const voteEndAt = new Date(election.voting_end_at)

  if (now < voteEndAt) return // 投票还未结束

  // 获取得票最高的候选人
  const { data: topCandidate } = await supabase
    .from('group_leader_applications')
    .select('user_id, vote_count')
    .eq('election_id', electionId)
    .order('vote_count', { ascending: false })
    .limit(1)
    .single()

  if (topCandidate && topCandidate.vote_count > 0) {
    // 设置新组长
    // 先将所有 owner 改为 admin
    await supabase
      .from('group_members')
      .update({ role: 'admin' })
      .eq('group_id', groupId)
      .eq('role', 'owner')

    // 设置新组长
    await supabase
      .from('group_members')
      .update({ role: 'owner' })
      .eq('group_id', groupId)
      .eq('user_id', topCandidate.user_id)

    // 更新小组状态
    await supabase
      .from('groups')
      .update({ 
        has_owner: true,
        created_by: topCandidate.user_id
      })
      .eq('id', groupId)

    // 更新选举状态
    await supabase
      .from('group_leader_elections')
      .update({
        status: 'closed',
        closed_at: now.toISOString(),
        winner_id: topCandidate.user_id
      })
      .eq('id', electionId)

    // 发送通知给新组长
    await supabase
      .from('notifications')
      .insert({
        user_id: topCandidate.user_id,
        type: 'system',
        title: '恭喜当选组长',
        message: '您已当选为小组新组长！',
        link: `/groups/${groupId}`
      })
  } else {
    // 没有候选人得票，延长选举
    const newEndAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    await supabase
      .from('group_leader_elections')
      .update({
        voting_end_at: newEndAt.toISOString()
      })
      .eq('id', electionId)
  }
}

// 获取竞选信息
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: groupId } = await params
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 获取进行中的竞选
    const { data: election } = await supabase
      .from('group_leader_elections')
      .select('*')
      .eq('group_id', groupId)
      .in('status', ['open', 'voting'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!election) {
      return NextResponse.json({ election: null })
    }

    // 检查是否需要结束
    if (election.status === 'voting') {
      await checkAndCloseElection(supabase, election.id, groupId)
      
      // 重新获取状态
      const { data: updatedElection } = await supabase
        .from('group_leader_elections')
        .select('*')
        .eq('id', election.id)
        .single()

      if (updatedElection?.status === 'closed') {
        return NextResponse.json({ election: null })
      }
    }

    // 获取候选人列表
    const { data: candidates } = await supabase
      .from('group_leader_applications')
      .select(`
        id,
        user_id,
        statement,
        vote_count,
        created_at,
        user:user_profiles!group_leader_applications_user_id_fkey(handle, avatar_url)
      `)
      .eq('election_id', election.id)
      .order('vote_count', { ascending: false })

    // 检查当前用户状态
    let userApplied = false
    let userVoted = false
    let userVotedFor: string | null = null

    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)

      if (user) {
        // 检查是否已申请
        const { data: appData } = await supabase
          .from('group_leader_applications')
          .select('id')
          .eq('election_id', election.id)
          .eq('user_id', user.id)
          .maybeSingle()
        
        userApplied = !!appData

        // 检查是否已投票
        const { data: voteData } = await supabase
          .from('group_leader_votes')
          .select('application_id')
          .eq('election_id', election.id)
          .eq('user_id', user.id)
          .maybeSingle()
        
        userVoted = !!voteData
        userVotedFor = voteData?.application_id || null
      }
    }

    // 获取成员数
    const memberCount = await getGroupMemberCount(supabase, groupId)

    return NextResponse.json({
      election: {
        ...election,
        candidates,
        user_applied: userApplied,
        user_voted: userVoted,
        user_voted_for: userVotedFor,
        member_count: memberCount
      }
    })

  } catch (error) {
    console.error('Get election error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// 申请竞选组长
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
      return NextResponse.json({ error: '只有小组成员可以参选' }, { status: 403 })
    }

    const body = await request.json()
    const { statement } = body

    if (!statement || statement.trim().length < 10) {
      return NextResponse.json({ error: '竞选宣言至少需要10个字' }, { status: 400 })
    }

    // 获取进行中的竞选
    let { data: election } = await supabase
      .from('group_leader_elections')
      .select('*')
      .eq('group_id', groupId)
      .in('status', ['open', 'voting'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // 如果没有竞选，检查小组是否无组长
    if (!election) {
      const { data: group } = await supabase
        .from('groups')
        .select('has_owner')
        .eq('id', groupId)
        .single()

      if (group?.has_owner !== false) {
        return NextResponse.json({ error: '当前没有进行中的组长竞选' }, { status: 400 })
      }

      // 创建新的竞选
      const { data: newElection, error: createError } = await supabase
        .from('group_leader_elections')
        .insert({
          group_id: groupId,
          status: 'open'
        })
        .select()
        .single()

      if (createError) {
        console.error('Create election error:', createError)
        return NextResponse.json({ error: '创建竞选失败' }, { status: 500 })
      }

      election = newElection
    }

    // 检查是否已申请
    const { data: existingApp } = await supabase
      .from('group_leader_applications')
      .select('id')
      .eq('election_id', election.id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingApp) {
      return NextResponse.json({ error: '您已经申请过了' }, { status: 400 })
    }

    // 创建申请
    const { error: applyError } = await supabase
      .from('group_leader_applications')
      .insert({
        election_id: election.id,
        user_id: user.id,
        statement: statement.trim()
      })

    if (applyError) {
      console.error('Apply error:', applyError)
      return NextResponse.json({ error: '申请失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: '申请已提交'
    })

  } catch (error) {
    console.error('Apply leader error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
