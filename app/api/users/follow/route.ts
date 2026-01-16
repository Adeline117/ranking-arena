/**
 * 用户互相关注 API
 * GET: 检查关注状态
 * POST: 关注/取消关注用户
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// 获取关注状态
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const followerId = searchParams.get('followerId')
    const followingId = searchParams.get('followingId')

    if (!followerId || !followingId) {
      return NextResponse.json({ error: 'Missing followerId or followingId' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
  } catch (error) {
    console.error('[User Follow API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// 关注/取消关注
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { followerId, followingId, action } = body

    if (!followerId || !followingId || !action) {
      return NextResponse.json({ error: 'Missing followerId, followingId or action' }, { status: 400 })
    }

    if (followerId === followingId) {
      return NextResponse.json({ error: '不能关注自己' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
        return NextResponse.json({ error: error.message }, { status: 500 })
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
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, following: false, mutual: false })
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error) {
    console.error('[User Follow API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


