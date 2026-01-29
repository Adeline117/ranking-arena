/**
 * 获取用户的关注列表 API
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export async function GET(
  request: NextRequest,
  { params }: { params: { handle: string } | Promise<{ handle: string }> }
) {
  try {
    const resolvedParams = await Promise.resolve(params)
    const handle = resolvedParams.handle
    
    if (!handle) {
      return NextResponse.json({ error: 'Missing handle' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 获取请求者的ID（用于判断隐私权限）
    const requesterId = request.nextUrl.searchParams.get('requesterId')

    // 首先获取目标用户的ID和隐私设置
    const { data: targetUser, error: userError } = await supabase
      .from('user_profiles')
      .select('id, handle, show_following')
      .eq('handle', handle)
      .maybeSingle()

    if (userError || !targetUser) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 })
    }

    // 检查隐私设置：如果关闭了关注列表展示，只有本人可以查看
    if (!targetUser.show_following && requesterId !== targetUser.id) {
      return NextResponse.json({ 
        following: [],
        hidden: true,
        message: '该用户已关闭关注列表展示'
      })
    }

    // 获取关注列表
    const { data: following, error: followingError } = await supabase
      .from('user_follows')
      .select(`
        id,
        created_at,
        following:user_profiles!user_follows_following_id_fkey(
          id,
          handle,
          bio,
          avatar_url
        )
      `)
      .eq('follower_id', targetUser.id)
      .order('created_at', { ascending: false })
      .limit(100)

    if (followingError) {
      // 表不存在时返回空数组
      if (followingError.message?.includes('Could not find')) {
        return NextResponse.json({ following: [], count: 0 })
      }
      console.error('[Following API] 查询错误:', followingError)
      return NextResponse.json({ error: followingError.message }, { status: 500 })
    }

    // 如果有请求者ID，检查请求者是否关注了这些人
    let followStatus: Record<string, boolean> = {}
    if (requesterId && following && following.length > 0) {
      const followingIds = following.map((f: any) => f.following?.id).filter(Boolean)
      
      const { data: myFollows } = await supabase
        .from('user_follows')
        .select('following_id')
        .eq('follower_id', requesterId)
        .in('following_id', followingIds)

      if (myFollows) {
        followStatus = myFollows.reduce((acc: Record<string, boolean>, f: any) => {
          acc[f.following_id] = true
          return acc
        }, {})
      }
    }

    const formattedFollowing = (following || []).map((f: any) => ({
      id: f.following?.id,
      handle: f.following?.handle,
      bio: f.following?.bio,
      avatar_url: f.following?.avatar_url,
      followed_at: f.created_at,
      is_following: followStatus[f.following?.id] || false
    })).filter((f: any) => f.id)

    return NextResponse.json({
      following: formattedFollowing,
      count: formattedFollowing.length
    })
  } catch (error: unknown) {
    console.error('[Following API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
