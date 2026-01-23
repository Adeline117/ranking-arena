import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'

const logger = createLogger('posts-delete')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: postId } = await params

    // 验证用户身份
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const token = authHeader.split(' ')[1]
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 验证 token 并获取用户
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '认证失败' }, { status: 401 })
    }

    // 获取帖子信息，验证所有权
    const { data: post, error: fetchError } = await supabase
      .from('posts')
      .select('author_id')
      .eq('id', postId)
      .single()

    if (fetchError || !post) {
      return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
    }

    if (post.author_id !== user.id) {
      return NextResponse.json({ error: '无权删除此帖子' }, { status: 403 })
    }

    // 删除帖子相关的评论
    const { error: commentsDeleteError } = await supabase
      .from('comments')
      .delete()
      .eq('post_id', postId)

    if (commentsDeleteError) {
      logger.error('Failed to delete comments', { error: commentsDeleteError, postId })
      // Continue with deletion - orphaned comments are less critical
    }

    // 删除帖子相关的点赞
    const { error: likesDeleteError } = await supabase
      .from('post_likes')
      .delete()
      .eq('post_id', postId)

    if (likesDeleteError) {
      logger.error('Failed to delete post likes', { error: likesDeleteError, postId })
      // Continue with deletion - orphaned likes are less critical
    }

    // 删除帖子
    const { error: deleteError } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId)

    if (deleteError) {
      logger.error('Delete error', { error: deleteError, postId, userId: user.id })
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    // 清除帖子列表缓存
    deleteServerCacheByPrefix('posts:')

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('Error deleting post', { error })
    const errorMessage = error instanceof Error ? error.message : '服务器错误'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

