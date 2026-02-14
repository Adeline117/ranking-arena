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
      return NextResponse.json({ error: 'Please log in first' }, { status: 401 })
    }

    const auth = { userId: user.id }

    const body = await req.json()
    const { content_type, content_id, reason, description, images } = body

    // Validate content_type
    if (!content_type || !VALID_CONTENT_TYPES.includes(content_type as ContentType)) {
      return NextResponse.json(
        { error: 'Invalid report type', valid_types: VALID_CONTENT_TYPES },
        { status: 400 }
      )
    }

    // Validate content_id
    if (!content_id || typeof content_id !== 'string') {
      return NextResponse.json({ error: 'Missing content ID' }, { status: 400 })
    }

    // Validate reason
    if (!reason || !VALID_REASONS.includes(reason as ReportReason)) {
      return NextResponse.json(
        { error: 'Please select a report reason', valid_reasons: VALID_REASONS },
        { status: 400 }
      )
    }

    // Validate description: required, min 15 chars, max 1000
    if (!description || typeof description !== 'string' || description.trim().length < 15) {
      return NextResponse.json({ error: 'Report reason must be at least 15 characters' }, { status: 400 })
    }
    if (description.length > 1000) {
      return NextResponse.json({ error: 'Report description max 1000 characters' }, { status: 400 })
    }

    // Validate images: at least 1 required
    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: 'Please upload at least one screenshot as evidence' }, { status: 400 })
    }
    if (images.length > 4) {
      return NextResponse.json({ error: 'Maximum 4 screenshots' }, { status: 400 })
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
      return NextResponse.json({ error: 'You have already reported this content' }, { status: 400 })
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
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }

      if (conversation.user1_id !== auth.userId && conversation.user2_id !== auth.userId) {
        return NextResponse.json({ error: 'No permission to report this conversation' }, { status: 403 })
      }
    } else if (content_type === 'user') {
      // For user reports, content_id is the user_id being reported
      const { data: reportedUser } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('id', content_id)
        .maybeSingle()

      if (!reportedUser) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 })
      }

      // Can't report yourself
      if (content_id === auth.userId) {
        return NextResponse.json({ error: 'Cannot report yourself' }, { status: 400 })
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
        images: images || [],
        status: 'pending',
      })
      .select()
      .single()

    if (error) {
      logger.error('Failed to create report', { error, userId: auth.userId, content_type, content_id })
      return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 })
    }

    logger.info('Report created', { reportId: report.id, userId: auth.userId, content_type, content_id, reason })

    return NextResponse.json({
      ok: true,
      message: 'Report submitted, we will review it shortly',
      report: {
        id: report.id,
        content_type: report.content_type,
        reason: report.reason,
        status: report.status,
        created_at: report.created_at,
      },
    })
  } catch (error: unknown) {
    logger.error('Reports API error', { error })
    const _errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
