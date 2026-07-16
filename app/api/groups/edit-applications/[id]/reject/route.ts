import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import {
  groupEditApplicationIdSchema,
  rejectGroupEditApplicationInputSchema,
  reviewGroupEditApplicationResultSchema,
  type ReviewGroupEditApplicationResult,
} from '../../contracts'

function rejectionFailureResponse(result: ReviewGroupEditApplicationResult): NextResponse {
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
    case 'dissolved':
      return NextResponse.json(
        { error: 'The group has been dissolved', code: 'GROUP_DISSOLVED' },
        { status: 409 }
      )
    case 'owner_changed':
      return NextResponse.json(
        { error: 'The applicant is no longer the group owner', code: 'OWNER_CHANGED' },
        { status: 409 }
      )
    case 'account_inactive':
      return NextResponse.json(
        { error: 'The applicant account is not active', code: 'ACCOUNT_INACTIVE' },
        { status: 409 }
      )
    case 'premium_change_unsupported':
      return NextResponse.json(
        {
          error: 'Premium access mode cannot be changed through a profile edit',
          code: 'PREMIUM_CHANGE_UNSUPPORTED',
        },
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
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
  }
}

// 拒绝小组信息修改申请
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const supabase = getSupabaseAdmin()

    // SECURITY: use verifyAdmin so ADMIN_EMAILS env allowlist is enforced in
    // production (matches /api/admin/* gating). Replaces a DB-only role check
    // that would have bypassed the operational whitelist.
    const admin = await verifyAdmin(supabase, request.headers.get('Authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }
    const parsedApplicationId = groupEditApplicationIdSchema.safeParse((await params).id)
    if (!parsedApplicationId.success) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = rejectGroupEditApplicationInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid rejection request' }, { status: 400 })
    }
    const reason = parsedBody.data.reason ?? null

    const { data, error } = await supabase.rpc('review_group_edit_application_atomic', {
      p_reviewer_id: admin.id,
      p_application_id: parsedApplicationId.data,
      p_decision: 'reject',
      p_reject_reason: reason,
      p_operation_id: parsedBody.data.operation_id,
    })

    if (error) {
      logger.error('Atomic group edit application rejection failed', {
        error,
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    const parsedResult = reviewGroupEditApplicationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group edit application rejection returned an invalid result', {
        applicationId: parsedApplicationId.data,
        reviewerId: admin.id,
      })
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    const result = parsedResult.data
    if (result.status !== 'rejected') return rejectionFailureResponse(result)
    if (
      result.operation_id !== parsedBody.data.operation_id ||
      result.application_id !== parsedApplicationId.data ||
      result.reject_reason !== reason
    ) {
      logger.error(
        'Atomic group edit application rejection returned a mismatched acknowledgement',
        {
          applicationId: parsedApplicationId.data,
          reviewerId: admin.id,
        }
      )
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Edit application rejected',
      operation_id: result.operation_id,
      application: {
        id: result.application_id,
        group_id: result.group_id,
        status: 'rejected',
        reject_reason: result.reject_reason,
      },
    })
  } catch (error: unknown) {
    logger.error('Error rejecting edit application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
