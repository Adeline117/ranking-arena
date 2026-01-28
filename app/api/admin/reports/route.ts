/**
 * 内容举报管理 API
 * GET /api/admin/reports - 获取举报列表
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('admin-reports')

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    // 速率限制检查（Admin 路由使用 sensitive 预设：15次/分钟）
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
    if (rateLimitResponse) {
      logger.warn('Rate limit exceeded for admin/reports')
      return rateLimitResponse
    }

    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')

    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const { searchParams } = new URL(req.url)
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')
    const status = searchParams.get('status') || 'pending' // pending, resolved, dismissed, all
    const contentType = searchParams.get('content_type') || 'all' // post, comment, message, user, all
    
    const offset = (page - 1) * limit
    
    let query = supabase
      .from('content_reports')
      .select('*', { count: 'exact' })
    
    // Apply status filter
    if (status !== 'all') {
      query = query.eq('status', status)
    }
    
    // Apply content type filter
    if (contentType !== 'all') {
      query = query.eq('content_type', contentType)
    }
    
    // Apply pagination and ordering
    const { data: reports, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    
    if (error) {
      logger.error('Error fetching reports', { error, page, limit, status, contentType })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    // Enrich reports with reporter info and content preview
    // 使用 Promise.allSettled 确保单个查询失败不会导致整个列表失败
    const enrichResults = await Promise.allSettled(
      (reports || []).map(async (report) => {
        // Get reporter info
        const { data: reporter } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .eq('id', report.reporter_id)
          .maybeSingle()

        // Get content preview
        let contentPreview = null
        let contentAuthor = null

        if (report.content_type === 'post') {
          const { data: post } = await supabase
            .from('posts')
            .select('id, title, content, author_id, author_handle')
            .eq('id', report.content_id)
            .maybeSingle()

          if (post) {
            contentPreview = {
              title: post.title,
              content: post.content?.slice(0, 200),
            }
            contentAuthor = {
              id: post.author_id,
              handle: post.author_handle,
            }
          }
        } else if (report.content_type === 'comment') {
          const { data: comment } = await supabase
            .from('comments')
            .select('id, content, author_id, author_handle')
            .eq('id', report.content_id)
            .maybeSingle()

          if (comment) {
            contentPreview = {
              content: comment.content?.slice(0, 200),
            }
            contentAuthor = {
              id: comment.author_id,
              handle: comment.author_handle,
            }
          }
        } else if (report.content_type === 'message') {
          // For message reports, content_id is the conversation_id
          const { data: conversation } = await supabase
            .from('conversations')
            .select('id, user1_id, user2_id, last_message_preview, last_message_at')
            .eq('id', report.content_id)
            .maybeSingle()

          if (conversation) {
            // Get the other user (not the reporter)
            const otherUserId = conversation.user1_id === report.reporter_id
              ? conversation.user2_id
              : conversation.user1_id

            const { data: otherUser } = await supabase
              .from('user_profiles')
              .select('id, handle, avatar_url')
              .eq('id', otherUserId)
              .maybeSingle()

            contentPreview = {
              title: `对话 ID: ${conversation.id.slice(0, 8)}...`,
              content: conversation.last_message_preview || '(无消息预览)',
            }
            contentAuthor = otherUser ? {
              id: otherUser.id,
              handle: otherUser.handle,
            } : null
          }
        } else if (report.content_type === 'user') {
          // For user reports, content_id is the user being reported
          const { data: reportedUser } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url, bio')
            .eq('id', report.content_id)
            .maybeSingle()

          if (reportedUser) {
            contentPreview = {
              title: `用户: @${reportedUser.handle || reportedUser.id.slice(0, 8)}`,
              content: reportedUser.bio || '(无个人简介)',
            }
            contentAuthor = {
              id: reportedUser.id,
              handle: reportedUser.handle,
            }
          }
        }

        return {
          ...report,
          reporter: reporter || { id: report.reporter_id, handle: '未知用户', avatar_url: null },
          contentPreview,
          contentAuthor,
        }
      })
    )

    // 过滤成功的结果，记录失败的
    const enrichedReports = enrichResults
      .filter((result): result is PromiseFulfilledResult<any> => {
        if (result.status === 'rejected') {
          logger.warn('Failed to enrich report', { error: String(result.reason) })
          return false
        }
        return true
      })
      .map(result => result.value)
    
    return NextResponse.json({
      ok: true,
      reports: enrichedReports,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    logger.error('Reports API error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
