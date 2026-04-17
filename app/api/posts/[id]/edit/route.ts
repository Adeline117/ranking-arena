import { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { socialFeatureGuard } from '@/lib/features'

const logger = createLogger('posts-edit')

// 内容长度限制
const MAX_TITLE_LENGTH = 200
const MAX_CONTENT_LENGTH = 50000

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id: postId } = await params

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }

      const { title, content } = body as { title?: string; content?: string }

      if (!title?.trim()) {
        return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 })
      }

      // 内容长度验证
      if ((title as string).length > MAX_TITLE_LENGTH) {
        return NextResponse.json({ error: `Title cannot exceed ${MAX_TITLE_LENGTH} characters` }, { status: 400 })
      }

      if (content && (content as string).length > MAX_CONTENT_LENGTH) {
        return NextResponse.json({ error: `Content cannot exceed ${MAX_CONTENT_LENGTH} characters` }, { status: 400 })
      }

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
        return NextResponse.json({ error: 'No permission to edit this post' }, { status: 403 })
      }

      // 更新帖子
      const { data: updatedPost, error: updateError } = await supabase
        .from('posts')
        .update({
          title: (title as string).trim(),
          content: content?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', postId)
        .select()
        .single()

      if (updateError) {
        logger.error('Update error', { error: updateError, postId, userId: user.id })
        return NextResponse.json({ error: 'Update failed' }, { status: 500 })
      }

      // 清除帖子列表缓存
      deleteServerCacheByPrefix('posts:')

      return NextResponse.json({ success: true, post: updatedPost })
    },
    { name: 'posts-edit', rateLimit: 'write' }
  )

  return handler(request)
}
