/**
 * 内容举报 API (用户端)
 * POST /api/reports - 提交举报
 */

import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'

const logger = createLogger('reports')

export const dynamic = 'force-dynamic'

// Valid content types and reasons
const VALID_CONTENT_TYPES = ['post', 'comment', 'message', 'user'] as const
const VALID_REASONS = ['spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other'] as const

type ContentType = typeof VALID_CONTENT_TYPES[number]
type ReportReason = typeof VALID_REASONS[number]

export async function POST(req: NextRequest) {
  try {
    // Rate limit: reports are write operations
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.write)
    if (rateLimitResponse) {
      logger.warn('Rate limit exceeded for reports')
      return rateLimitResponse
    }

    // Verify authentication
    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }

    const auth = { userId: user.id }

    const body = await req.json()
    const { content_type, content_id, reason, description } = body

    // Validate content_type
    if (!content_type || !VALID_CONTENT_TYPES.includes(content_type as ContentType)) {
      return NextResponse.json(
        { error: '无效的举报类型', valid_types: VALID_CONTENT_TYPES },
        { status: 400 }
      )
    }

    // Validate content_id
    if (!content_id || typeof content_id !== 'string') {
      return NextResponse.json({ error: '缺少内容ID' }, { status: 400 })
    }

    // Validate reason
    if (!reason || !VALID_REASONS.includes(reason as ReportReason)) {
      return NextResponse.json(
        { error: '请选择举报原因', valid_reasons: VALID_REASONS },
        { status: 400 }
      )
    }

    // Validate description length
    if (description && typeof description === 'string' && description.length > 1000) {
      return NextResponse.json({ error: '举报说明最多1000字符' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Check if user already reported this content
    const { data: existingReport } = await supabase
      .from('content_reports')
      .select('id')
      .eq('reporter_id', auth.userId)
      .eq('content_type', content_type)
      .eq('content_id', content_id)
      .maybeSingle()

    if (existingReport) {
      return NextResponse.json({ error: '您已举报过此内容' }, { status: 400 })
    }

    // Validate that the content exists and user has access
    if (content_type === 'message') {
      // For messages, content_id is the conversation_id
      // Check if user is part of this conversation
      const { data: conversation } = await supabase
        .from('conversations')
        .select('id, user1_id, user2_id')
        .eq('id', content_id)
        .maybeSingle()

      if (!conversation) {
        return NextResponse.json({ error: '对话不存在' }, { status: 404 })
      }

      if (conversation.user1_id !== auth.userId && conversation.user2_id !== auth.userId) {
        return NextResponse.json({ error: '无权举报此对话' }, { status: 403 })
      }
    } else if (content_type === 'user') {
      // For user reports, content_id is the user_id being reported
      const { data: reportedUser } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('id', content_id)
        .maybeSingle()

      if (!reportedUser) {
        return NextResponse.json({ error: '用户不存在' }, { status: 404 })
      }

      // Can't report yourself
      if (content_id === auth.userId) {
        return NextResponse.json({ error: '不能举报自己' }, { status: 400 })
      }
    }

    // Insert the report
    const { data: report, error } = await supabase
      .from('content_reports')
      .insert({
        reporter_id: auth.userId,
        content_type,
        content_id,
        reason,
        description: description?.trim() || null,
        status: 'pending',
      })
      .select()
      .single()

    if (error) {
      logger.error('Failed to create report', { error, userId: auth.userId, content_type, content_id })
      return NextResponse.json({ error: '举报提交失败' }, { status: 500 })
    }

    logger.info('Report created', { reportId: report.id, userId: auth.userId, content_type, content_id, reason })

    return NextResponse.json({
      ok: true,
      message: '举报已提交，我们会尽快处理',
      report: {
        id: report.id,
        content_type: report.content_type,
        reason: report.reason,
        status: report.status,
        created_at: report.created_at,
      },
    })
  } catch (error) {
    logger.error('Reports API error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
