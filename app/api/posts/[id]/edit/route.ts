import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('posts-edit')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function PUT(
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

    // 获取请求体
    const body = await request.json()
    const { title, content } = body

    if (!title?.trim()) {
      return NextResponse.json({ error: '标题不能为空' }, { status: 400 })
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
      return NextResponse.json({ error: '无权编辑此帖子' }, { status: 403 })
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
      return NextResponse.json({ error: '更新失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true, post: updatedPost })
  } catch (error) {
    logger.error('Error editing post', { error })
    const errorMessage = error instanceof Error ? error.message : '服务器错误'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

