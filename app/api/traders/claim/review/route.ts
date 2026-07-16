/**
 * Admin: Review trader claim
 * POST /api/traders/claim/review
 * Body: { claimId, approved, rejectReason? }
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { validateString, validateUUID } from '@/lib/api'
import { reviewClaim } from '@/lib/data/trader-claims'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      let body: { claimId?: unknown; approved?: unknown; rejectReason?: unknown }
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }

      const claimId = validateUUID(body.claimId, { required: true, fieldName: 'claimId' })
      if (typeof body.approved !== 'boolean') {
        throw ApiError.validation('approved must be a boolean')
      }
      const approved = body.approved
      if (body.rejectReason != null && typeof body.rejectReason !== 'string') {
        throw ApiError.validation('rejectReason must be a string')
      }
      const rejectReason = validateString(body.rejectReason, {
        maxLength: 500,
        fieldName: 'rejectReason',
      })

      if (!claimId) {
        throw ApiError.validation('claimId is required')
      }

      const claim = await reviewClaim(
        supabase,
        claimId,
        admin.id,
        approved,
        rejectReason || undefined
      ).catch((error: unknown) => {
        const code = (error as { code?: string })?.code
        if (code === '23505') {
          throw new ApiError('Trader identity is already claimed', { statusCode: 409 })
        }
        if (code === 'P0002') {
          throw ApiError.notFound('Trader claim is no longer reviewable')
        }
        throw error
      })

      return apiSuccess({
        claim,
        message: approved ? 'Claim approved' : 'Claim rejected',
      })
    },
    { name: 'trader-claim-review' }
  )

  return handler(req)
}
