/**
 * Admin: Review trader claim
 * POST /api/traders/claim/review
 * Body: { claimId, approved, rejectReason? }
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { validateString } from '@/lib/api'
import { reviewClaim } from '@/lib/data/trader-claims'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const handler = withAdminAuth(
    async ({ admin, supabase }) => {
      let body: { claimId?: string; approved?: boolean; rejectReason?: string }
      try {
        body = await req.json()
      } catch {
        throw ApiError.validation('Invalid JSON in request body')
      }

      const claimId = validateString(body.claimId, { required: true, fieldName: 'claimId' })
      const approved = body.approved === true
      const rejectReason = body.rejectReason || undefined

      if (!claimId) {
        throw ApiError.validation('claimId is required')
      }

      const claim = await reviewClaim(supabase, claimId, admin.id, approved, rejectReason)

      // If approved, update user_profiles with verified trader info
      if (approved && claim) {
        await supabase
          .from('user_profiles')
          .update({
            is_verified_trader: true,
            verified_trader_id: claim.trader_id,
            verified_trader_source: claim.source,
          })
          .eq('id', claim.user_id)
      }

      return apiSuccess({
        claim,
        message: approved ? 'Claim approved' : 'Claim rejected',
      })
    },
    { name: 'trader-claim-review' }
  )

  return handler(req)
}
