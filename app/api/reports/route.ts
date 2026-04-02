/**
 * 内容举报 API (用户端)
 * POST /api/reports - 提交举报
 */

import { NextRequest } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { success as apiSuccess, handleError } from '@/lib/api/response'

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
      throw ApiError.unauthorized('Please log in first')
    }

    const auth = { userId: user.id }

    const body = await req.json()
    const { content_type, content_id, reason, description, images } = body

    // Validate content_type
    if (!content_type || !VALID_CONTENT_TYPES.includes(content_type as ContentType)) {
      throw ApiError.validation('Invalid report type', { valid_types: VALID_CONTENT_TYPES as unknown as Record<string, unknown> })
    }

    // Validate content_id
    if (!content_id || typeof content_id !== 'string') {
      throw ApiError.validation('Missing content ID')
    }

    // Validate reason
    if (!reason || !VALID_REASONS.includes(reason as ReportReason)) {
      throw ApiError.validation('Please select a report reason', { valid_reasons: VALID_REASONS as unknown as Record<string, unknown> })
    }

    // Validate description: required, min 15 chars, max 1000
    if (!description || typeof description !== 'string' || description.trim().length < 15) {
      throw ApiError.validation('Report reason must be at least 15 characters')
    }
    if (description.length > 1000) {
      throw ApiError.validation('Report description max 1000 characters')
    }

    // Validate images: at least 1 required
    if (!images || !Array.isArray(images) || images.length === 0) {
      throw ApiError.validation('Please upload at least one screenshot as evidence')
    }
    if (images.length > 4) {
      throw ApiError.validation('Maximum 4 screenshots')
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
      throw new ApiError('You have already reported this content', {
        code: ErrorCode.DUPLICATE_ACTION,
      })
    }

    // Validate that the content exists and user has access
    if (content_type === 'message') {
      const { data: conversation } = await supabase
        .from('conversations')
        .select('id, user1_id, user2_id')
        .eq('id', content_id)
        .maybeSingle()

      if (!conversation) {
        throw ApiError.notFound('Conversation not found')
      }

      if (conversation.user1_id !== auth.userId && conversation.user2_id !== auth.userId) {
        throw ApiError.forbidden('No permission to report this conversation')
      }
    } else if (content_type === 'user') {
      const { data: reportedUser } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('id', content_id)
        .maybeSingle()

      if (!reportedUser) {
        throw ApiError.notFound('User not found')
      }

      if (content_id === auth.userId) {
        throw ApiError.validation('Cannot report yourself')
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
      throw ApiError.database('Failed to submit report')
    }

    logger.info('Report created', { reportId: report.id, userId: auth.userId, content_type, content_id, reason })

    return apiSuccess({
      message: 'Report submitted, we will review it shortly',
      report: {
        id: report.id,
        content_type: report.content_type,
        reason: report.reason,
        status: report.status,
        created_at: report.created_at,
      },
    }, 201)
  } catch (error: unknown) {
    logger.error('Reports API error', { error })
    return handleError(error, 'reports')
  }
}
