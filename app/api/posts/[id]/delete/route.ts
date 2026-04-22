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

      // Delete the post — comments, likes, bookmarks, reactions cascade via FK constraints.
      // Previous code manually deleted children before the post, which was both
      // redundant (CASCADE handles it) and non-transactional (partial failure left orphans).
      const { error: deleteError } = await supabase.from('posts').delete().eq('id', postId)

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
