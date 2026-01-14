/**
 * 帖子收藏 API
 * POST /api/posts/[id]/bookmark - 收藏/取消收藏
 * GET /api/posts/[id]/bookmark - 检查是否已收藏
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

type RouteContext = { params: Promise<{ id: string }> }

// 检查用户是否已收藏
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ bookmarked: false })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ bookmarked: false })
    }

    const { data: bookmark } = await supabase
      .from('post_bookmarks')
      .select('id')
      .eq('post_id', id)
      .eq('user_id', user.id)
      .maybeSingle()

    return NextResponse.json({ bookmarked: !!bookmark })

  } catch (error) {
    console.error('Error checking bookmark:', error)
    return NextResponse.json({ bookmarked: false })
  }
}

// 收藏/取消收藏
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

    // 检查帖子是否存在
    const { data: post } = await supabase
      .from('posts')
      .select('id')
      .eq('id', id)
      .maybeSingle()

    if (!post) {
      return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
    }

    // 检查是否已收藏
    const { data: existingBookmark } = await supabase
      .from('post_bookmarks')
      .select('id')
      .eq('post_id', id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingBookmark) {
      // 已收藏，取消收藏
      const { error: deleteError } = await supabase
        .from('post_bookmarks')
        .delete()
        .eq('id', existingBookmark.id)

      if (deleteError) {
        console.error('Error removing bookmark:', deleteError)
        return NextResponse.json({ error: '取消收藏失败' }, { status: 500 })
      }

      // 获取更新后的收藏数
      const { data: updatedPost } = await supabase
        .from('posts')
        .select('bookmark_count')
        .eq('id', id)
        .single()

      return NextResponse.json({
        action: 'removed',
        bookmarked: false,
        bookmark_count: updatedPost?.bookmark_count || 0
      })
    } else {
      // 未收藏，添加收藏
      // 获取请求体中的 folder_id
      let folder_id = null
      try {
        const body = await request.json()
        folder_id = body.folder_id || null
      } catch {
        // 没有请求体，使用默认收藏夹
      }

      // 如果没有指定收藏夹，确保有默认收藏夹并使用它
      if (!folder_id) {
        const { data: defaultFolder } = await supabase
          .from('bookmark_folders')
          .select('id')
          .eq('user_id', user.id)
          .eq('is_default', true)
          .maybeSingle()

        if (defaultFolder) {
          folder_id = defaultFolder.id
        } else {
          // 创建默认收藏夹
          const { data: newFolder } = await supabase
            .from('bookmark_folders')
            .insert({
              user_id: user.id,
              name: '默认收藏夹',
              is_default: true
            })
            .select('id')
            .single()
          
          if (newFolder) {
            folder_id = newFolder.id
          }
        }
      }

      const { error: insertError } = await supabase
        .from('post_bookmarks')
        .insert({
          post_id: id,
          user_id: user.id,
          folder_id: folder_id
        })

      if (insertError) {
        console.error('Error adding bookmark:', insertError)
        return NextResponse.json({ error: '收藏失败' }, { status: 500 })
      }

      // 获取更新后的收藏数
      const { data: updatedPost } = await supabase
        .from('posts')
        .select('bookmark_count')
        .eq('id', id)
        .single()

      return NextResponse.json({
        action: 'added',
        bookmarked: true,
        bookmark_count: updatedPost?.bookmark_count || 0,
        folder_id: folder_id
      })
    }

  } catch (error) {
    console.error('Error toggling bookmark:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

