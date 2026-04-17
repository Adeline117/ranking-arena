import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { socialFeatureGuard } from '@/lib/features'

const logger = createLogger('posts-delete')

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id: postId } = await params

  const handler = withAuth(
    async ({ user, supabase }) => {
      // 获取帖子信息，验证所有权
      const { data: post, error: fetchError } = await supabase
        .from('posts')
        .select('author_id')
        .eq('id', postId)
        .single()

      if (fetchError || !post) {
        return NextResponse.json({ error: 'Post not found' }, { status: 404 })
      }

      if (post.author_id !== user.id) {
        return NextResponse.json({ error: 'No permission to delete this post' }, { status: 403 })
      }

      // 删除帖子相关的评论（记录错误但继续删除帖子）
      const { error: commentsError } = await supabase
        .from('comments')
        .delete()
        .eq('post_id', postId)

      if (commentsError) {
        logger.warn('Failed to delete comments', { error: commentsError.message, postId })
      }

      // 删除帖子相关的点赞（记录错误但继续删除帖子）
      const { error: likesError } = await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', postId)

      if (likesError) {
        logger.warn('Failed to delete likes', { error: likesError.message, postId })
      }

      // 删除帖子收藏（记录错误但继续删除帖子）
      const { error: bookmarksError } = await supabase
        .from('post_bookmarks')
        .delete()
        .eq('post_id', postId)

      if (bookmarksError) {
        logger.warn('Failed to delete bookmarks', { error: bookmarksError.message, postId })
      }

      // 删除帖子
      const { error: deleteError } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId)

      if (deleteError) {
        logger.error('Delete error', { error: deleteError, postId, userId: user.id })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      // 清除帖子列表缓存
      deleteServerCacheByPrefix('posts:')

      return NextResponse.json({ success: true })
    },
    { name: 'posts-delete', rateLimit: 'write' }
  )

  return handler(request)
}
