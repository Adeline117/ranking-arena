/**
 * 帖子收藏 API
 * POST /api/posts/[id]/bookmark - 收藏/取消收藏
 * GET /api/posts/[id]/bookmark - 检查是否已收藏
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth, withApiMiddleware } from '@/lib/api/middleware'
import { apiLogger } from '@/lib/utils/logger'
import { updateCountSync } from '@/lib/services/counters'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'

// Zod schema for POST /api/posts/[id]/bookmark (body is optional)
const BookmarkSchema = z
  .object({
    folder_id: z.string().uuid().optional().nullable(),
  })
  .optional()
const PostIdSchema = z.string().uuid()

type RouteContext = { params: Promise<{ id: string }> }

// 检查用户是否已收藏 (auth optional — returns { bookmarked: false } when unauthenticated)
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id } = await context.params
  const postId = PostIdSchema.safeParse(id)
  if (!postId.success) {
    return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withApiMiddleware(
    async ({ user, supabase }) => {
      if (!user) {
        return NextResponse.json({ bookmarked: false })
      }

      if (!(await canServiceActorReadPost(supabase, postId.data, user.id))) {
        return NextResponse.json({ bookmarked: false })
      }

      const { data: bookmark } = await supabase
        .from('post_bookmarks')
        .select('id')
        .eq('post_id', postId.data)
        .eq('user_id', user.id)
        .maybeSingle()

      return NextResponse.json({ bookmarked: !!bookmark })
    },
    { name: 'posts-bookmark-check', rateLimit: 'authenticated', readsAuth: true }
  )

  return handler(request)
}

// 收藏/取消收藏
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id } = await context.params
  const postId = PostIdSchema.safeParse(id)
  if (!postId.success) {
    return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      // 获取请求体中的 folder_id（提前获取，用于判断是移动收藏夹还是取消收藏）
      let folder_id: string | null = null
      try {
        const body = await req.json()
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

      if (!(await canServiceActorReadPost(supabase, postId.data, user.id))) {
        return NextResponse.json({ error: 'Post not found' }, { status: 404 })
      }

      if (folder_id) {
        const { data: ownedFolder, error: folderError } = await supabase
          .from('bookmark_folders')
          .select('id')
          .eq('id', folder_id)
          .eq('user_id', user.id)
          .maybeSingle()

        if (folderError) {
          apiLogger.error('Error checking bookmark folder:', folderError)
          return NextResponse.json({ error: 'Failed to check bookmark folder' }, { status: 500 })
        }
        if (!ownedFolder) {
          return NextResponse.json({ error: 'Bookmark folder not found' }, { status: 404 })
        }
      }

      const { data: existingBookmark, error: existingBookmarkError } = await supabase
        .from('post_bookmarks')
        .select('id, folder_id')
        .eq('post_id', postId.data)
        .eq('user_id', user.id)
        .maybeSingle()

      if (existingBookmarkError) {
        apiLogger.error('Error checking bookmark:', existingBookmarkError)
        return NextResponse.json({ error: 'Failed to check bookmark' }, { status: 500 })
      }

      if (existingBookmark) {
        // 如果指定了 folder_id，则是移动到其他收藏夹，不是取消收藏
        if (folder_id && folder_id !== existingBookmark.folder_id) {
          // 更新收藏夹
          const { error: updateError } = await supabase
            .from('post_bookmarks')
            .update({ folder_id: folder_id })
            .eq('id', existingBookmark.id)
            .eq('post_id', postId.data)
            .eq('user_id', user.id)

          if (updateError) {
            apiLogger.error('Error updating bookmark folder:', updateError)
            return NextResponse.json({ error: 'Failed to move bookmark folder' }, { status: 500 })
          }

          // 获取当前帖子的收藏计数（不变）
          const { data: currentPost } = await supabase
            .from('posts')
            .select('bookmark_count')
            .eq('id', postId.data)
            .single()

          return NextResponse.json({
            action: 'moved',
            bookmarked: true,
            bookmark_count: currentPost?.bookmark_count || 1,
            folder_id: folder_id,
          })
        }

        // 没有指定 folder_id 或 folder_id 相同，则取消收藏
        const { error: deleteError } = await supabase
          .from('post_bookmarks')
          .delete()
          .eq('id', existingBookmark.id)
          .eq('post_id', postId.data)
          .eq('user_id', user.id)

        if (deleteError) {
          apiLogger.error('Error removing bookmark:', deleteError)
          return NextResponse.json({ error: 'Failed to remove bookmark' }, { status: 500 })
        }

        const newCount = await updateCountSync(
          supabase,
          'decrement_bookmark_count',
          { post_id: postId.data },
          'Decrement bookmark count'
        )

        return NextResponse.json({
          action: 'removed',
          bookmarked: false,
          bookmark_count: newCount ?? 0,
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
            // Use upsert-like pattern: try insert, on unique violation re-query.
            // The partial unique index (idx_bookmark_folders_one_default_per_user)
            // prevents the TOCTOU race where two requests both create a default folder.
            const { data: newFolder, error: createFolderError } = await supabase
              .from('bookmark_folders')
              .insert({
                user_id: user.id,
                name: 'Default',
                is_default: true,
              })
              .select('id')
              .single()

            if (createFolderError) {
              // 23505 = unique violation → another request created it first, re-query
              if (createFolderError.code === '23505') {
                const { data: existingFolder } = await supabase
                  .from('bookmark_folders')
                  .select('id')
                  .eq('user_id', user.id)
                  .eq('is_default', true)
                  .maybeSingle()
                if (existingFolder) folder_id = existingFolder.id
              } else {
                apiLogger.error('Error creating default folder:', createFolderError)
              }
              // 继续但不设置 folder_id
            } else if (newFolder) {
              folder_id = newFolder.id
            }
          }
        }

        // 构建插入数据，如果没有 folder_id 则不包含该字段
        const insertData: { post_id: string; user_id: string; folder_id?: string } = {
          post_id: postId.data,
          user_id: user.id,
        }
        if (folder_id) {
          insertData.folder_id = folder_id
        }

        const { error: insertError } = await supabase.from('post_bookmarks').insert(insertData)

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

        const newCount = await updateCountSync(
          supabase,
          'increment_bookmark_count',
          { post_id: postId.data },
          'Increment bookmark count'
        )

        return NextResponse.json({
          action: 'added',
          bookmarked: true,
          bookmark_count: newCount ?? 1,
          folder_id: folder_id,
        })
      }
    },
    { name: 'posts-bookmark', rateLimit: 'write' }
  )

  return handler(request)
}
