import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查是否是系统管理员
async function isAdmin(supabase: SupabaseClient<any>, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  
  return profile?.role === 'admin'
}

// 开始投票阶段（自动或由管理员触发）
export async function POST(
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
      .eq('status', 'open')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!election) {
      return NextResponse.json({ error: '没有进行中的竞选' }, { status: 400 })
    }

    // 检查是否有候选人
    const { count: candidateCount } = await supabase
      .from('group_leader_applications')
      .select('*', { count: 'exact', head: true })
      .eq('election_id', election.id)

    if (!candidateCount || candidateCount === 0) {
      return NextResponse.json({ error: '还没有候选人' }, { status: 400 })
    }

    // 可选：检查管理员权限
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)
      
      // 如果是管理员，可以手动开始投票
      // 否则可能需要其他条件（如达到一定数量的候选人，或等待一段时间）
    }

    // 开始投票
    const now = new Date()
    const voteEndAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) // 14天后

    const { error: updateError } = await supabase
      .from('group_leader_elections')
      .update({
        status: 'voting',
        voting_started_at: now.toISOString(),
        voting_end_at: voteEndAt.toISOString()
      })
      .eq('id', election.id)

    if (updateError) {
      console.error('Start voting error:', updateError)
      return NextResponse.json({ error: '开始投票失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: '投票已开始',
      voting_end_at: voteEndAt.toISOString()
    })

  } catch (error) {
    console.error('Start voting error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
