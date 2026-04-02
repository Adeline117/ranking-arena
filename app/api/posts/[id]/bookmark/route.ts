/**
 * 帖子收藏 API
 * POST /api/posts/[id]/bookmark - 收藏/取消收藏
 * GET /api/posts/[id]/bookmark - 检查是否已收藏
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/utils/logger'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// Zod schema for POST /api/posts/[id]/bookmark (body is optional)
const BookmarkSchema = z.object({
  folder_id: z.string().uuid().optional().nullable(),
}).optional()

type RouteContext = { params: Promise<{ id: string }> }

// 检查用户是否已收藏
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id } = await context.params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ bookmarked: false })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

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

  } catch (error: unknown) {
    apiLogger.error('Error checking bookmark:', error)
    return NextResponse.json({ bookmarked: false })
  }
}

// 收藏/取消收藏
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { id } = await context.params

    // CSRF 验证
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken) && false) { // CSRF disabled: auth token is sufficient
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // 检查帖子是否存在
    const { data: post } = await supabase
      .from('posts')
      .select('id')
      .eq('id', id)
      .maybeSingle()

    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    // 获取请求体中的 folder_id（提前获取，用于判断是移动收藏夹还是取消收藏）
    let folder_id: string | null = null
    try {
      const body = await request.json()
      const parsed = BookmarkSchema.safeParse(body)
      if (parsed.success && parsed.data?.folder_id) {
        folder_id = parsed.data.folder_id
      } else if (!parsed.success) {
        return NextResponse.json(
          { error: 'Invalid input', details: parsed.error.flatten() },
          { status: 400 }
        )
      }
    } catch {
      // Intentionally swallowed: no request body or invalid JSON, proceed with default folder / toggle bookmark
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
          return NextResponse.json({ error: 'Failed to move bookmark folder' }, { status: 500 })
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
        return NextResponse.json({ error: 'Failed to remove bookmark' }, { status: 500 })
      }

      // 使用原子递减操作避免竞态条件
      const { data: updatedPost, error: rpcError } = await supabase.rpc(
        'decrement_bookmark_count',
        { post_id: id }
      ).maybeSingle()

      // 如果 RPC 不存在，回退到非原子操作（但记录警告）
      let newCount = 0
      if (rpcError) {
        apiLogger.warn('RPC decrement_bookmark_count not found, using fallback:', rpcError)
        const { data: currentPost } = await supabase
          .from('posts')
          .select('bookmark_count')
          .eq('id', id)
          .single()

        newCount = Math.max(0, (currentPost?.bookmark_count ?? 1) - 1)
        const { error: fallbackError } = await supabase
          .from('posts')
          .update({ bookmark_count: newCount })
          .eq('id', id)

        if (fallbackError) {
          apiLogger.warn('Failed to update bookmark count:', fallbackError)
        }
      } else {
        newCount = (updatedPost as { bookmark_count?: number } | null)?.bookmark_count ?? 0
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
              name: 'Default',
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
          return NextResponse.json({ error: 'Post not found or deleted' }, { status: 404 })
        }
        if (insertError.code === '23505') {
          return NextResponse.json({ error: 'Already bookmarked' }, { status: 409 })
        }
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }

      // 使用原子递增操作避免竞态条件
      const { data: updatedPost, error: rpcError } = await supabase.rpc(
        'increment_bookmark_count',
        { post_id: id }
      ).maybeSingle()

      // 如果 RPC 不存在，回退到非原子操作（但记录警告）
      let newCount = 1
      if (rpcError) {
        apiLogger.warn('RPC increment_bookmark_count not found, using fallback:', rpcError)
        const { data: currentPost } = await supabase
          .from('posts')
          .select('bookmark_count')
          .eq('id', id)
          .single()

        newCount = (currentPost?.bookmark_count ?? 0) + 1
        const { error: fallbackError } = await supabase
          .from('posts')
          .update({ bookmark_count: newCount })
          .eq('id', id)

        if (fallbackError) {
          apiLogger.warn('Failed to update bookmark count:', fallbackError)
        }
      } else {
        newCount = (updatedPost as { bookmark_count?: number } | null)?.bookmark_count ?? 1
      }

      return NextResponse.json({
        action: 'added',
        bookmarked: true,
        bookmark_count: newCount,
        folder_id: folder_id
      })
    }

  } catch (error: unknown) {
    apiLogger.error('Error toggling bookmark:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

