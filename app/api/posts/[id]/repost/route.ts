/**
 * 帖子转发 API
 * POST /api/posts/[id]/repost - 转发帖子
 * DELETE /api/posts/[id]/repost - 取消转发
 * GET /api/posts/[id]/repost - 检查是否已转发
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

type RouteContext = { params: Promise<{ id: string }> }

// 检查用户是否已转发
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ reposted: false })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ reposted: false })
    }

    const { data: repost } = await supabase
      .from('reposts')
      .select('id, comment')
      .eq('post_id', id)
      .eq('user_id', user.id)
      .maybeSingle()

    return NextResponse.json({ 
      reposted: !!repost,
      comment: repost?.comment || null
    })

  } catch (error) {
    console.error('Error checking repost:', error)
    return NextResponse.json({ reposted: false })
  }
}

// 转发帖子
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    
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

    // 解析请求体
    const body = await request.json().catch(() => ({}))
    const comment = body.comment?.trim() || null

    // 检查帖子是否存在
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('id', id)
      .maybeSingle()

    if (!post) {
      return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
    }

    // 不能转发自己的帖子
    if (post.author_id === user.id) {
      return NextResponse.json({ error: '不能转发自己的帖子' }, { status: 400 })
    }

    // 检查是否已转发
    const { data: existingRepost } = await supabase
      .from('reposts')
      .select('id')
      .eq('post_id', id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingRepost) {
      return NextResponse.json({ error: '已经转发过此帖子' }, { status: 400 })
    }

    // 创建转发
    const { error: insertError } = await supabase
      .from('reposts')
      .insert({
        post_id: id,
        user_id: user.id,
        comment
      })

    if (insertError) {
      console.error('Error creating repost:', insertError)
      return NextResponse.json({ error: '转发失败' }, { status: 500 })
    }

    // 获取更新后的转发数
    const { data: updatedPost } = await supabase
      .from('posts')
      .select('repost_count')
      .eq('id', id)
      .single()

    return NextResponse.json({
      success: true,
      reposted: true,
      repost_count: updatedPost?.repost_count || 0
    })

  } catch (error) {
    console.error('Error creating repost:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// 取消转发
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    
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

    // 删除转发
    const { error: deleteError } = await supabase
      .from('reposts')
      .delete()
      .eq('post_id', id)
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('Error deleting repost:', deleteError)
      return NextResponse.json({ error: '取消转发失败' }, { status: 500 })
    }

    // 获取更新后的转发数
    const { data: updatedPost } = await supabase
      .from('posts')
      .select('repost_count')
      .eq('id', id)
      .single()

    return NextResponse.json({
      success: true,
      reposted: false,
      repost_count: updatedPost?.repost_count || 0
    })

  } catch (error) {
    console.error('Error deleting repost:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

