import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

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

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id: postId } = await params

    // CSRF 验证
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    // 验证用户身份
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.split(' ')[1]
    const supabase = getSupabaseAdmin()

    // 验证 token 并获取用户
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // 获取请求体
    const body = await request.json()
    const { title, content } = body

    if (!title?.trim()) {
      return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 })
    }

    // 内容长度验证
    if (title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json({ error: `Title cannot exceed ${MAX_TITLE_LENGTH} characters` }, { status: 400 })
    }

    if (content && content.length > MAX_CONTENT_LENGTH) {
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
        title: title.trim(),
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
  } catch (error: unknown) {
    logger.error('Error editing post', { error })
    const _errorMessage = error instanceof Error ? error.message : 'Server error'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

