/**
 * 帖子收藏 API
 * POST /api/posts/[id]/bookmark - 收藏/取消收藏
 * GET /api/posts/[id]/bookmark - 检查是否已收藏
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { apiLogger } from '@/lib/utils/logger'

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
    apiLogger.error('Error checking bookmark:', error)
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

    // 获取请求体中的 folder_id（提前获取，用于判断是移动收藏夹还是取消收藏）
    let folder_id = null
    try {
      const body = await request.json()
      folder_id = body.folder_id || null
    } catch {
      // 没有请求体，使用默认收藏夹或取消收藏
    }

    // 检查是否已收藏
    const { data: existingBookmark } = await supabase
      .from('post_bookmarks')
      .select('id, folder_id')
      .eq('post_id', id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingBookmark) {
      // 如果指定了 folder_id，则是移动到其他收藏夹，不是取消收藏
      if (folder_id && folder_id !== existingBookmark.folder_id) {
        // 更新收藏夹
        const { error: updateError } = await supabase
          .from('post_bookmarks')
          .update({ folder_id: folder_id })
          .eq('id', existingBookmark.id)

        if (updateError) {
          apiLogger.error('Error updating bookmark folder:', updateError)
          return NextResponse.json({ error: '移动收藏夹失败' }, { status: 500 })
        }

        // 获取当前帖子的收藏计数（不变）
        const { data: currentPost } = await supabase
          .from('posts')
          .select('bookmark_count')
          .eq('id', id)
          .single()

        return NextResponse.json({
          action: 'moved',
          bookmarked: true,
          bookmark_count: currentPost?.bookmark_count || 1,
          folder_id: folder_id
        })
      }

      // 没有指定 folder_id 或 folder_id 相同，则取消收藏
      const { error: deleteError } = await supabase
        .from('post_bookmarks')
        .delete()
        .eq('id', existingBookmark.id)

      if (deleteError) {
        apiLogger.error('Error removing bookmark:', deleteError)
        return NextResponse.json({ error: '取消收藏失败' }, { status: 500 })
      }

      // 手动更新收藏计数（因为触发器可能不工作）
      // Re-fetch to reduce race condition window
      const { data: currentPost, error: fetchError } = await supabase
        .from('posts')
        .select('bookmark_count')
        .eq('id', id)
        .single()

      if (fetchError) {
        apiLogger.warn('Failed to fetch current bookmark count:', fetchError)
      }

      const currentCount = currentPost?.bookmark_count ?? 0
      const newCount = Math.max(0, currentCount - 1)

      const { error: updateError } = await supabase
        .from('posts')
        .update({ bookmark_count: newCount })
        .eq('id', id)

      if (updateError) {
        apiLogger.warn('Failed to update bookmark count:', updateError)
        // Still return success since the bookmark was removed
      }

      return NextResponse.json({
        action: 'removed',
        bookmarked: false,
        bookmark_count: newCount
      })
    } else {
      // 未收藏，添加收藏
      // 如果没有指定收藏夹，确保有默认收藏夹并使用它
      if (!folder_id) {
        const { data: defaultFolder, error: folderQueryError } = await supabase
          .from('bookmark_folders')
          .select('id')
          .eq('user_id', user.id)
          .eq('is_default', true)
          .maybeSingle()

        if (folderQueryError) {
          apiLogger.error('Error querying default folder:', folderQueryError)
          // 如果 bookmark_folders 表不存在，继续但不设置 folder_id
        }

        if (defaultFolder) {
          folder_id = defaultFolder.id
        } else if (!folderQueryError) {
          // 只有在表存在时才尝试创建默认收藏夹
          const { data: newFolder, error: createFolderError } = await supabase
            .from('bookmark_folders')
            .insert({
              user_id: user.id,
              name: '默认收藏夹',
              is_default: true
            })
            .select('id')
            .single()
          
          if (createFolderError) {
            apiLogger.error('Error creating default folder:', createFolderError)
            // 继续但不设置 folder_id
          } else if (newFolder) {
            folder_id = newFolder.id
          }
        }
      }

      // 构建插入数据，如果没有 folder_id 则不包含该字段
      const insertData: { post_id: string; user_id: string; folder_id?: string } = {
        post_id: id,
        user_id: user.id,
      }
      if (folder_id) {
        insertData.folder_id = folder_id
      }

      const { error: insertError } = await supabase
        .from('post_bookmarks')
        .insert(insertData)

      if (insertError) {
        apiLogger.error('Error adding bookmark:', insertError)
        // 提供更详细的错误信息
        if (insertError.code === '23503') {
          return NextResponse.json({ error: '帖子不存在或已被删除' }, { status: 404 })
        }
        if (insertError.code === '23505') {
          return NextResponse.json({ error: '已经收藏过此帖子' }, { status: 409 })
        }
        return NextResponse.json({ error: `收藏失败: ${insertError.message}` }, { status: 500 })
      }

      // 手动更新收藏计数（因为触发器可能不工作）
      // Re-fetch to reduce race condition window
      const { data: currentPost, error: fetchError } = await supabase
        .from('posts')
        .select('bookmark_count')
        .eq('id', id)
        .single()

      if (fetchError) {
        apiLogger.warn('Failed to fetch current bookmark count:', fetchError)
      }

      const currentCount = currentPost?.bookmark_count ?? 0
      const newCount = currentCount + 1

      const { error: updateError } = await supabase
        .from('posts')
        .update({ bookmark_count: newCount })
        .eq('id', id)

      if (updateError) {
        apiLogger.warn('Failed to update bookmark count:', updateError)
        // Still return success since the bookmark was added
      }

      return NextResponse.json({
        action: 'added',
        bookmarked: true,
        bookmark_count: newCount,
        folder_id: folder_id
      })
    }

  } catch (error) {
    apiLogger.error('Error toggling bookmark:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

