/**
 * 内容举报 API (用户端)
 * POST /api/reports - 提交举报
 */

import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { success as apiSuccess, badRequest, handleError } from '@/lib/api/response'
import { z } from 'zod'

const logger = createLogger('reports')

export const dynamic = 'force-dynamic'

const VALID_CONTENT_TYPES = ['post', 'comment', 'message', 'user'] as const
const VALID_REASONS = [
  'spam',
  'harassment',
  'inappropriate',
  'misinformation',
  'fraud',
  'other',
] as const

const EvidenceUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:' && !/\s/.test(value)
    } catch {
      return false
    }
  }, 'Evidence must be an HTTPS URL')

const SubmitReportSchema = z.object({
  content_type: z.enum(VALID_CONTENT_TYPES),
  content_id: z.string().uuid('Invalid content ID'),
  reason: z.enum(VALID_REASONS),
  description: z.string().trim().min(15).max(1000),
  images: z.array(EvidenceUrlSchema).min(1).max(4),
})

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }
      const parsed = SubmitReportSchema.safeParse(body)
      if (!parsed.success) {
        throw ApiError.validation('Invalid report input', {
          fields: parsed.error.flatten().fieldErrors,
        })
      }
      const { content_type, content_id, reason, description, images } = parsed.data

      // Check if user already reported this content
      const { data: existingReport, error: existingReportError } = await supabase
        .from('content_reports')
        .select('id')
        .eq('reporter_id', user.id)
        .eq('content_type', content_type)
        .eq('content_id', content_id)
        .eq('status', 'pending')
        .maybeSingle()

      if (existingReportError) {
        throw ApiError.database('Failed to verify duplicate report')
      }
      if (existingReport) {
        throw new ApiError('You have already reported this content', {
          code: ErrorCode.DUPLICATE_ACTION,
        })
      }

      // Validate that the content exists and user has access
      if (content_type === 'post') {
        const { data: post, error: postError } = await supabase
          .from('posts')
          .select('id, author_id, status, deleted_at')
          .eq('id', content_id)
          .maybeSingle()

        if (postError) throw ApiError.database('Failed to verify post')
        if (!post || post.deleted_at || post.status === 'deleted') {
          throw ApiError.notFound('Post not found')
        }
        if (post.author_id === user.id) {
          throw ApiError.validation('Cannot report your own post')
        }
      } else if (content_type === 'comment') {
        const { data: comment, error: commentError } = await supabase
          .from('comments')
          .select('id, user_id, deleted_at')
          .eq('id', content_id)
          .maybeSingle()

        if (commentError) throw ApiError.database('Failed to verify comment')
        if (!comment || comment.deleted_at) {
          throw ApiError.notFound('Comment not found')
        }
        if (comment.user_id === user.id) {
          throw ApiError.validation('Cannot report your own comment')
        }
      } else if (content_type === 'message') {
        const { data: conversation, error: conversationError } = await supabase
          .from('conversations')
          .select('id, user1_id, user2_id')
          .eq('id', content_id)
          .maybeSingle()

        if (conversationError) throw ApiError.database('Failed to verify conversation')
        if (!conversation) {
          throw ApiError.notFound('Conversation not found')
        }

        if (conversation.user1_id !== user.id && conversation.user2_id !== user.id) {
          throw ApiError.forbidden('No permission to report this conversation')
        }
      } else if (content_type === 'user') {
        const { data: reportedUser, error: reportedUserError } = await supabase
          .from('user_profiles')
          .select('id, deleted_at')
          .eq('id', content_id)
          .maybeSingle()

        if (reportedUserError) throw ApiError.database('Failed to verify user')
        if (!reportedUser || reportedUser.deleted_at) {
          throw ApiError.notFound('User not found')
        }

        if (content_id === user.id) {
          throw ApiError.validation('Cannot report yourself')
        }
      }

      // Insert the report
      const { data: report, error } = await supabase
        .from('content_reports')
        .insert({
          reporter_id: user.id,
          content_type,
          content_id,
          reason,
          description,
          images,
          status: 'pending',
        })
        .select()
        .single()

      if (error) {
        logger.error('Failed to create report', {
          error,
          userId: user.id,
          content_type,
          content_id,
        })
        throw ApiError.database('Failed to submit report')
      }

      logger.info('Report created', {
        reportId: report.id,
        userId: user.id,
        content_type,
        content_id,
        reason,
      })

      return apiSuccess(
        {
          message: 'Report submitted, we will review it shortly',
          report: {
            id: report.id,
            content_type: report.content_type,
            reason: report.reason,
            status: report.status,
            created_at: report.created_at,
          },
        },
        201
      )
    } catch (error: unknown) {
      return handleError(error, 'reports')
    }
  },
  { name: 'reports-post', rateLimit: 'write' }
)
