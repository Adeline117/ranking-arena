import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import { notifyNewGroup } from '@/lib/notifications/activity-alerts'
import { sendNotification } from '@/lib/data/notifications'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import {
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

    const { data, error } = await supabase.rpc('review_group_application_atomic', {
      p_reviewer_id: admin.id,
      p_application_id: parsedApplicationId.data,
      p_decision: 'approve',
      p_reject_reason: null,
      p_promo_unlocked: PRO_FREE_PROMO,
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

    sendNotification(
      supabase,
      {
        user_id: result.applicant_id,
        type: 'system',
        title: 'Group approved',
        message: `Your group "${result.group_name}" has been approved`,
        link: `/groups/${result.group_id}`,
        reference_id: result.group_id,
      },
      'group-approved'
    )
    notifyNewGroup(null, result.group_name)

    return NextResponse.json({
      success: true,
      message: 'Group application approved',
      group: { id: result.group_id },
    })
  } catch (error: unknown) {
    logger.error('Error approving application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
