/**
 * 用户互相关注 API
 * GET: 检查关注状态
 * POST: 关注/取消关注用户
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * 验证用户身份并返回用户ID
 */
 
async function authenticateUser(request: NextRequest, supabase: ReturnType<typeof createClient<any>>): Promise<{ userId: string } | { error: string; status: number }> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: '未授权：缺少认证令牌', status: 401 }
  }

  const token = authHeader.slice(7)
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return { error: '身份验证失败', status: 401 }
  }

  return { userId: user.id }
}

// 获取关注状态
export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
    if (rateLimitResponse) return rateLimitResponse

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 验证用户身份
    const authResult = await authenticateUser(request, supabase)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    const followerId = authResult.userId

    const searchParams = request.nextUrl.searchParams
    const followingId = searchParams.get('followingId')

    if (!followingId) {
      return NextResponse.json({ error: 'Missing followingId' }, { status: 400 })
    }

    // 检查 A 是否关注 B
    const { data: followData, error: followError } = await supabase
      .from('user_follows')
      .select('*')
      .eq('follower_id', followerId)
      .eq('following_id', followingId)
      .maybeSingle()

    if (followError && !followError.message?.includes('Could not find')) {
      console.error('[User Follow API] 查询错误:', followError)
      return NextResponse.json({ error: followError.message }, { status: 500 })
    }

    // 检查是否互相关注
    const { data: reverseData } = await supabase
      .from('user_follows')
      .select('*')
      .eq('follower_id', followingId)
      .eq('following_id', followerId)
      .maybeSingle()

    return NextResponse.json({
      following: !!followData,
      followedBy: !!reverseData,
      mutual: !!followData && !!reverseData
    })
  } catch (error: unknown) {
    console.error('[User Follow API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// 关注/取消关注
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 验证用户身份 - followerId 必须从认证token获取
    const authResult = await authenticateUser(request, supabase)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    const followerId = authResult.userId

    const body = await request.json()
    const { followingId, action } = body

    if (!followingId || !action) {
      return NextResponse.json({ error: 'Missing followingId or action' }, { status: 400 })
    }

    if (followerId === followingId) {
      return NextResponse.json({ error: '不能关注自己' }, { status: 400 })
    }

    if (action === 'follow') {
      // 关注用户
      const { error } = await supabase
        .from('user_follows')
        .insert({ follower_id: followerId, following_id: followingId })

      if (error) {
        // 如果是重复关注，忽略错误
        if (error.code === '23505') {
          return NextResponse.json({ success: true, following: true })
        }
        if (error.message?.includes('Could not find the table')) {
          return NextResponse.json({ error: '关注功能暂未开放', tableNotFound: true }, { status: 503 })
        }
        console.error('[User Follow API] 关注错误:', error)
        return NextResponse.json({ error: error.message || '关注操作失败' }, { status: 500 })
      }

      // 检查是否互相关注
      const { data: reverseData } = await supabase
        .from('user_follows')
        .select('*')
        .eq('follower_id', followingId)
        .eq('following_id', followerId)
        .maybeSingle()

      return NextResponse.json({ 
        success: true, 
        following: true,
        mutual: !!reverseData
      })
    } else if (action === 'unfollow') {
      // 取消关注
      const { error } = await supabase
        .from('user_follows')
        .delete()
        .eq('follower_id', followerId)
        .eq('following_id', followingId)

      if (error) {
        if (error.message?.includes('Could not find the table')) {
          return NextResponse.json({ error: '关注功能暂未开放', tableNotFound: true }, { status: 503 })
        }
        console.error('[User Follow API] 取消关注错误:', error)
        return NextResponse.json({ error: error.message || '取消关注操作失败' }, { status: 500 })
      }

      return NextResponse.json({ success: true, following: false, mutual: false })
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error: unknown) {
    console.error('[User Follow API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


