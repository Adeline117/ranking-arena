import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import { notifyNewGroup } from '@/lib/notifications/activity-alerts'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import {
  approveGroupApplicationInputSchema,
  groupApplicationIdSchema,
  reviewGroupApplicationResultSchema,
  type ReviewGroupApplicationResult,
} from '../../contracts'

function approvalFailureResponse(result: ReviewGroupApplicationResult): NextResponse {
  switch (result.status) {
    case 'invalid':
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
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
      return NextResponse.json(
        { error: 'The applicant account is not active', code: 'ACCOUNT_INACTIVE' },
        { status: 409 }
      )
    case 'pro_required':
      return NextResponse.json(
        { error: 'The applicant no longer has an active Pro membership', code: 'PRO_REQUIRED' },
        { status: 409 }
      )
    case 'name_taken':
      return NextResponse.json(
        { error: 'A group with this name already exists', code: 'NAME_TAKEN' },
        { status: 409 }
      )
    case 'operation_conflict':
      return NextResponse.json(
        { error: 'Operation id conflicts with another request' },
        { status: 409 }
      )
    default:
      return NextResponse.json({ error: 'Approval failed' }, { status: 500 })
  }
}

// 批准小组申请
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

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = approveGroupApplicationInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid approval request' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('review_group_application_atomic', {
      p_reviewer_id: admin.id,
      p_application_id: parsedApplicationId.data,
      p_decision: 'approve',
      p_reject_reason: null,
      p_promo_unlocked: PRO_FREE_PROMO,
      p_operation_id: parsedBody.data.operation_id,
    })

    if (error) {
      logger.error('Atomic group application approval failed', {
        error,
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Approval failed' }, { status: 500 })
    }

    const parsedResult = reviewGroupApplicationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group application approval returned an invalid result', {
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Approval failed' }, { status: 500 })
    }

    const result = parsedResult.data
    if (result.status !== 'approved') return approvalFailureResponse(result)
    if (
      result.operation_id !== parsedBody.data.operation_id ||
      result.application_id !== parsedApplicationId.data
    ) {
      logger.error('Atomic group application approval returned a mismatched acknowledgement', {
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Approval failed' }, { status: 500 })
    }

    if (result.applied) void notifyNewGroup(null, result.group_name)

    return NextResponse.json({
      success: true,
      message: 'Group application approved',
      operation_id: result.operation_id,
      group: { id: result.group_id },
    })
  } catch (error: unknown) {
    logger.error('Error approving application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
