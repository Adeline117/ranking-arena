import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'

const UuidSchema = z.string().uuid()
const ReviewBodySchema = z.object({ decision: z.enum(['approve', 'reject']) }).strict()

type AtomicReviewResult = {
  status: string
  request_status?: string
}

function readRouteIds(url: string): { groupId: string; requestId: string } | null {
  try {
    const parts = new URL(url).pathname.split('/')
    const groupsIndex = parts.indexOf('groups')
    const requestsIndex = parts.indexOf('join-requests')
    const groupId = UuidSchema.safeParse(parts[groupsIndex + 1])
    const requestId = UuidSchema.safeParse(parts[requestsIndex + 1])
    return groupId.success && requestId.success
      ? { groupId: groupId.data, requestId: requestId.data }
      : null
  } catch {
    return null
  }
}

function readAtomicResult(value: unknown): AtomicReviewResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  if (typeof result.status !== 'string') return null
  return {
    status: result.status,
    ...(typeof result.request_status === 'string' ? { request_status: result.request_status } : {}),
  }
}

export const POST = withAuth(
  async ({ user, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const routeIds = readRouteIds(request.url)
    if (!routeIds) {
      return NextResponse.json({ error: 'Invalid group or request ID' }, { status: 400 })
    }

    const parsedBody = ReviewBodySchema.safeParse(await request.json().catch(() => null))
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Decision must be approve or reject' }, { status: 400 })
    }

    let userScoped: ReturnType<typeof createUserScopedServerClient>
    try {
      userScoped = createUserScopedServerClient(request)
    } catch (error) {
      logger.error('Failed to create RLS-scoped join-request review client', error)
      return NextResponse.json({ error: 'Failed to review join request' }, { status: 500 })
    }

    // This caller-scoped read binds the nested URL to an immutable request
    // identity and avoids leaking cross-group request IDs. The write RPC still
    // rechecks the actor's live owner/admin role and the request's final state.
    const { data: requestRow, error: requestError } = await userScoped
      .from('group_join_requests')
      .select('id, group_id, user_id')
      .eq('id', routeIds.requestId)
      .eq('group_id', routeIds.groupId)
      .maybeSingle()

    if (requestError) {
      logger.error('RLS-scoped join-request binding lookup failed', requestError)
      return NextResponse.json({ error: 'Failed to review join request' }, { status: 500 })
    }
    if (!requestRow) {
      return NextResponse.json({ error: 'Join request not found' }, { status: 404 })
    }

    const { data, error } = await getSupabaseAdmin().rpc(
      'review_group_join_request_atomic' as never,
      {
        p_actor_id: user.id,
        p_request_id: routeIds.requestId,
        p_decision: parsedBody.data.decision,
      } as never
    )

    if (error) {
      logger.error('Atomic join-request review failed', error)
      return NextResponse.json({ error: 'Failed to review join request' }, { status: 500 })
    }

    const result = readAtomicResult(data)
    if (!result) {
      logger.error('Atomic join-request review returned an invalid result', { data })
      return NextResponse.json({ error: 'Failed to review join request' }, { status: 500 })
    }

    const admin = getSupabaseAdmin()
    switch (result.status) {
      case 'approved':
        sendNotification(
          admin,
          {
            user_id: requestRow.user_id,
            type: 'group_update',
            title: 'Join request approved',
            message: 'Your request to join the group was approved',
            link: `/groups/${routeIds.groupId}`,
            actor_id: user.id,
            reference_id: routeIds.groupId,
          },
          'Join request approval notification'
        )
        return NextResponse.json({ success: true, decision: 'approved' })
      case 'rejected':
        sendNotification(
          admin,
          {
            user_id: requestRow.user_id,
            type: 'group_update',
            title: 'Join request rejected',
            message: 'Your request to join the group was not approved',
            link: `/groups/${routeIds.groupId}`,
            actor_id: user.id,
            reference_id: routeIds.groupId,
          },
          'Join request rejection notification'
        )
        return NextResponse.json({ success: true, decision: 'rejected' })
      case 'already_approved':
        return NextResponse.json({ success: true, decision: 'approved', already_approved: true })
      case 'already_member':
        return NextResponse.json({ success: true, decision: 'reconciled', already_member: true })
      case 'already_processed':
        if (parsedBody.data.decision === 'reject' && result.request_status === 'rejected') {
          return NextResponse.json({
            success: true,
            decision: 'rejected',
            already_processed: true,
          })
        }
        return NextResponse.json(
          {
            error: 'Join request was already processed',
            request_status: result.request_status ?? 'unknown',
          },
          { status: 409 }
        )
      case 'request_not_found':
      case 'target_not_found':
        return NextResponse.json({ error: 'Join request not found' }, { status: 404 })
      case 'not_found':
        return NextResponse.json({ error: 'Group not found' }, { status: 404 })
      case 'account_inactive':
      case 'forbidden':
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      case 'dissolved':
        return NextResponse.json({ error: 'This group has been dissolved' }, { status: 409 })
      case 'target_inactive':
        return NextResponse.json({ error: 'Applicant account is not active' }, { status: 409 })
      case 'target_banned':
        return NextResponse.json({ error: 'Applicant is banned from this group' }, { status: 409 })
      case 'invalid':
        return NextResponse.json({ error: 'Invalid review request' }, { status: 400 })
      default:
        logger.error('Atomic join-request review returned an unknown status', {
          status: result.status,
        })
        return NextResponse.json({ error: 'Failed to review join request' }, { status: 500 })
    }
  },
  { name: 'group-join-request-review', rateLimit: 'sensitive' }
)
