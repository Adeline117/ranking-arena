/**
 * Admin: Review trader claim
 * POST /api/traders/claim/review
 * Body: { claimId, approved, rejectReason? }
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import { reviewClaim } from '@/lib/data/trader-claims'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Check admin role
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!profile || profile.role !== 'admin') {
      throw ApiError.forbidden('Admin access required')
    }

    const body = await request.json()
    const claimId = validateString(body.claimId, { required: true, fieldName: 'claimId' })
    const approved = body.approved === true
    const rejectReason = body.rejectReason || undefined

    if (!claimId) {
      throw ApiError.validation('claimId is required')
    }

    const claim = await reviewClaim(supabase, claimId, user.id, approved, rejectReason)

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

    return success({
      claim,
      message: approved ? 'Claim approved' : 'Claim rejected',
    })
  } catch (error: unknown) {
    return handleError(error, 'claim review')
  }
}
