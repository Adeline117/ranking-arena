/**
 * 内容举报 API (用户端)
 * POST /api/reports - 提交举报
 */

import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { success as apiSuccess, badRequest, handleError } from '@/lib/api/response'
import { z } from 'zod'
import type { NextResponse } from 'next/server'
import { parseReportEvidenceRef } from '@/lib/reports/evidence'

const logger = createLogger('reports')
const NO_STORE = 'private, no-store'

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

const EvidenceRefSchema = z
  .string()
  .max(128)
  .refine((value) => parseReportEvidenceRef(value) !== null, 'Invalid evidence reference')

const SubmitReportSchema = z.object({
  content_type: z.enum(VALID_CONTENT_TYPES),
  content_id: z.string().uuid('Invalid content ID'),
  reason: z.enum(VALID_REASONS),
  description: z.string().trim().min(15).max(1000),
  images: z
    .array(EvidenceRefSchema)
    .min(1)
    .max(4)
    .refine((refs) => new Set(refs).size === refs.length, 'Duplicate evidence reference'),
})

const SubmitReportRpcResultSchema = z.discriminatedUnion('created', [
  z
    .object({
      created: z.literal(true),
      report_id: z.string().uuid(),
      status: z.literal('pending'),
      reason: z.enum(VALID_REASONS),
      content_type: z.enum(VALID_CONTENT_TYPES),
      created_at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      created: z.literal(false),
      report_id: z.string().uuid(),
      status: z.literal('pending'),
      reason: z.literal('DUPLICATE_PENDING'),
      content_type: z.enum(VALID_CONTENT_TYPES),
      created_at: z.string().datetime({ offset: true }),
    })
    .strict(),
])

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', NO_STORE)
  return response
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return noStore(badRequest('Invalid JSON body'))
      }
      const parsed = SubmitReportSchema.safeParse(body)
      if (!parsed.success) {
        throw ApiError.validation('Invalid report input', {
          fields: parsed.error.flatten().fieldErrors,
        })
      }
      const { content_type, content_id, reason, description, images } = parsed.data
      if (images.some((ref) => !parseReportEvidenceRef(ref, user.id))) {
        throw ApiError.validation('Invalid report evidence')
      }

      // Strict deploy order: 20260716112300 -> 20260716113800 -> the
      // 20260716114500 advisory-first lock migration -> this application. This
      // endpoint intentionally has no table fallback: the RPC is the sole
      // authorization, evidence validation, and write path.
      const { data: rpcData, error: rpcError } = await supabase.rpc('submit_content_report', {
        p_reporter_id: user.id,
        p_content_type: content_type,
        p_content_id: content_id,
        p_reason: reason,
        p_description: description,
        p_images: images,
      })

      if (rpcError) {
        logger.error('Atomic report submission failed', {
          error: rpcError,
          userId: user.id,
          content_type,
          content_id,
        })
        throw ApiError.database('Failed to submit report')
      }

      const rpcResult = SubmitReportRpcResultSchema.safeParse(rpcData)
      if (!rpcResult.success || rpcResult.data.content_type !== content_type) {
        throw ApiError.database('Invalid report submission result')
      }
      if (!rpcResult.data.created) {
        throw new ApiError('You have already reported this content', {
          code: ErrorCode.DUPLICATE_ACTION,
        })
      }
      if (rpcResult.data.reason !== reason) {
        throw ApiError.database('Invalid report submission result')
      }

      logger.info('Report created', {
        reportId: rpcResult.data.report_id,
        userId: user.id,
        content_type,
        content_id,
        reason,
      })

      return noStore(
        apiSuccess(
          {
            message: 'Report submitted, we will review it shortly',
            report: {
              id: rpcResult.data.report_id,
              content_type: rpcResult.data.content_type,
              reason: rpcResult.data.reason,
              status: rpcResult.data.status,
              created_at: rpcResult.data.created_at,
            },
          },
          201
        )
      )
    } catch (error: unknown) {
      return noStore(handleError(error, 'reports'))
    }
  },
  { name: 'reports-post', rateLimit: 'write' }
)
