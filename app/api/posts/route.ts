/**
 * 帖子列表 API
 * GET /api/posts - 获取帖子列表
 * POST /api/posts - 创建新帖子
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  getUserHandle,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
  validateEnum,
} from '@/lib/api'
import { getPosts, createPost, getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'

export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const group_id = validateString(searchParams.get('group_id')) ?? undefined
    const author_handle = validateString(searchParams.get('author_handle')) ?? undefined
    const sort_by = validateEnum(
      searchParams.get('sort_by'),
      ['created_at', 'hot_score', 'like_count'] as const
    ) ?? 'created_at'
    const sort_order = validateEnum(
      searchParams.get('sort_order'),
      ['asc', 'desc'] as const
    ) ?? 'desc'

    const posts = await getPosts(supabase, {
      limit,
      offset,
      group_id,
      author_handle,
      sort_by,
      sort_order,
    })

    // 如果用户已登录，获取用户的点赞和投票状态
    let userReactions: Map<string, 'up' | 'down'> = new Map()
    let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()

    const user = await getAuthUser(request)
    if (user && posts.length > 0) {
      const postIds = posts.map(p => p.id)
      userReactions = await getUserPostReactions(supabase, postIds, user.id)
      userVotes = await getUserPostVotes(supabase, postIds, user.id)
    }

    // 添加用户状态到帖子
    const postsWithUserState = posts.map(post => ({
      ...post,
      user_reaction: userReactions.get(post.id) || null,
      user_vote: userVotes.get(post.id) || null,
    }))

    return successWithPagination(
      { posts: postsWithUserState },
      { limit, offset, has_more: posts.length === limit }
    )
  } catch (error) {
    return handleError(error, 'posts GET')
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    // 验证输入
    const title = validateString(body.title, { required: true, minLength: 1, maxLength: 200, fieldName: '标题' })!
    const content = validateString(body.content, { required: true, minLength: 1, maxLength: 10000, fieldName: '内容' })!
    const group_id = validateString(body.group_id) ?? undefined
    const poll_enabled = body.poll_enabled === true

    // 获取用户 handle
    const userHandle = await getUserHandle(user.id, user.email)

    const post = await createPost(supabase, user.id, userHandle, {
      title,
      content,
      group_id,
      poll_enabled,
    })

    return success({ post }, 201)
  } catch (error) {
    return handleError(error, 'posts POST')
  }
}
