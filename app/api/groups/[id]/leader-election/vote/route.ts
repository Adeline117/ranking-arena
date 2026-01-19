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

// 组长竞选投票
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
      return NextResponse.json({ error: '只有小组成员可以投票' }, { status: 403 })
    }

    const body = await request.json()
    const { application_id } = body

    if (!application_id) {
      return NextResponse.json({ error: '请选择候选人' }, { status: 400 })
    }

    // 获取进行中的竞选
    const { data: election } = await supabase
      .from('group_leader_elections')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'voting')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!election) {
      return NextResponse.json({ error: '当前没有进行中的投票' }, { status: 400 })
    }

    // 检查投票是否已过期
    const now = new Date()
    const voteEndAt = new Date(election.voting_end_at)
    if (now > voteEndAt) {
      return NextResponse.json({ error: '投票已结束' }, { status: 400 })
    }

    // 验证候选人
    const { data: application } = await supabase
      .from('group_leader_applications')
      .select('id')
      .eq('id', application_id)
      .eq('election_id', election.id)
      .maybeSingle()

    if (!application) {
      return NextResponse.json({ error: '候选人不存在' }, { status: 404 })
    }

    // 检查是否已投票
    const { data: existingVote } = await supabase
      .from('group_leader_votes')
      .select('id')
      .eq('election_id', election.id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingVote) {
      return NextResponse.json({ error: '您已经投票过了' }, { status: 400 })
    }

    // 投票
    const { error: voteError } = await supabase
      .from('group_leader_votes')
      .insert({
        election_id: election.id,
        application_id,
        user_id: user.id
      })

    if (voteError) {
      console.error('Vote error:', voteError)
      return NextResponse.json({ error: '投票失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: '投票成功'
    })

  } catch (error) {
    console.error('Vote error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
