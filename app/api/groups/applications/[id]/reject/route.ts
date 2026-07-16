import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import {
  groupApplicationIdSchema,
  rejectGroupApplicationInputSchema,
  reviewGroupApplicationResultSchema,
  type ReviewGroupApplicationResult,
} from '../../contracts'

function rejectionFailureResponse(result: ReviewGroupApplicationResult): NextResponse {
  switch (result.status) {
    case 'invalid':
      return NextResponse.json({ error: 'Invalid rejection request' }, { status: 400 })
    case 'reviewer_inactive':
    case 'reviewer_unauthorized':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'not_found':
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    case 'already_processed':
      return NextResponse.json(
        { error: 'This application has already been processed' },
        { status: 409 }
      )
    case 'account_inactive':
      return NextResponse.json({ error: 'The applicant account is not active' }, { status: 409 })
    case 'operation_conflict':
      return NextResponse.json(
        { error: 'Operation id conflicts with another request' },
        { status: 409 }
      )
    default:
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
  }
}

// 拒绝小组申请
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const supabase = getSupabaseAdmin()
    const admin = await verifyAdmin(supabase, request.headers.get('Authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const parsedApplicationId = groupApplicationIdSchema.safeParse((await params).id)
    if (!parsedApplicationId.success) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    let rawBody: unknown = {}
    try {
      const rawText = await request.text()
      if (rawText.trim()) rawBody = JSON.parse(rawText)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = rejectGroupApplicationInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid rejection request' }, { status: 400 })
    }
    const reason = parsedBody.data.reason || null

    const { data, error } = await supabase.rpc('review_group_application_atomic', {
      p_reviewer_id: admin.id,
      p_application_id: parsedApplicationId.data,
      p_decision: 'reject',
      p_reject_reason: reason,
      p_promo_unlocked: PRO_FREE_PROMO,
      p_operation_id: parsedBody.data.operation_id,
    })

    if (error) {
      logger.error('Atomic group application rejection failed', {
        error,
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    const parsedResult = reviewGroupApplicationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group application rejection returned an invalid result', {
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    const result = parsedResult.data
    if (result.status !== 'rejected') return rejectionFailureResponse(result)
    if (
      result.operation_id !== parsedBody.data.operation_id ||
      result.application_id !== parsedApplicationId.data
    ) {
      logger.error('Atomic group application rejection returned a mismatched acknowledgement', {
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Group application rejected',
      operation_id: result.operation_id,
    })
  } catch (error: unknown) {
    logger.error('Error rejecting application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
