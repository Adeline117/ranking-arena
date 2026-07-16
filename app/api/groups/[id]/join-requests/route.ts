import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'
import { PRO_FREE_PROMO } from '@/lib/types/premium'

const UuidSchema = z.string().uuid()
const ListStatusSchema = z.enum(['pending', 'approved', 'active'])
const LIST_LIMIT = 100

type AtomicRequestResult = {
  status: string
  request_id?: string
}

function readGroupId(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/')
    const groupsIndex = parts.indexOf('groups')
    const parsed = UuidSchema.safeParse(parts[groupsIndex + 1])
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function readAtomicResult(value: unknown): AtomicRequestResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  if (typeof result.status !== 'string') return null
  return {
    status: result.status,
    ...(typeof result.request_id === 'string' ? { request_id: result.request_id } : {}),
  }
}

// The list intentionally runs with the caller JWT, not service_role. The
// table's RLS policy exposes all rows to group owners/admins and only the
// caller's own row otherwise.
export const GET = withAuth(
  async ({ request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = readGroupId(request.url)
    if (!groupId) {
      return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
    }

    const requestedStatus = new URL(request.url).searchParams.get('status') ?? 'pending'
    const parsedStatus = ListStatusSchema.safeParse(requestedStatus)
    if (!parsedStatus.success) {
      return NextResponse.json({ error: 'Invalid request status filter' }, { status: 400 })
    }

    let userScoped: ReturnType<typeof createUserScopedServerClient>
    try {
      userScoped = createUserScopedServerClient(request)
    } catch (error) {
      logger.error('Failed to create RLS-scoped join-request client', error)
      return NextResponse.json({ error: 'Failed to load join requests' }, { status: 500 })
    }

    let query = userScoped
      .from('group_join_requests')
      .select('id, group_id, user_id, answer_text, status, decided_by, decided_at, created_at')
      .eq('group_id', groupId)

    query =
      parsedStatus.data === 'active'
        ? query.in('status', ['pending', 'approved'])
        : query.eq('status', parsedStatus.data)

    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(LIST_LIMIT)

    if (error) {
      logger.error('RLS-scoped join-request list failed', error)
      return NextResponse.json({ error: 'Failed to load join requests' }, { status: 500 })
    }

    return NextResponse.json({ success: true, requests: data ?? [] })
  },
  { name: 'group-join-requests-list', rateLimit: 'read' }
)

// Cancellation is actor-owned and idempotent in the service-only RPC. The RPC
// serializes against approval and membership changes on the same user/group.
export const DELETE = withAuth(
  async ({ user, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = readGroupId(request.url)
    if (!groupId) {
      return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
    }

    const { data, error } = await getSupabaseAdmin().rpc(
      'mutate_group_join_request_atomic' as never,
      {
        p_actor_id: user.id,
        p_group_id: groupId,
        p_action: 'cancel',
        p_answer_text: null,
        p_pro_free_promo: PRO_FREE_PROMO,
      } as never
    )

    if (error) {
      logger.error('Atomic join-request cancellation failed', error)
      return NextResponse.json({ error: 'Failed to cancel join request' }, { status: 500 })
    }

    const result = readAtomicResult(data)
    if (!result) {
      logger.error('Atomic join-request cancellation returned an invalid result', { data })
      return NextResponse.json({ error: 'Failed to cancel join request' }, { status: 500 })
    }

    switch (result.status) {
      case 'cancelled': {
        const requestId = UuidSchema.safeParse(result.request_id)
        if (!requestId.success) {
          logger.error('Atomic join-request cancellation omitted a valid request ID', {
            request_id: result.request_id,
          })
          return NextResponse.json({ error: 'Failed to cancel join request' }, { status: 500 })
        }
        return NextResponse.json({
          success: true,
          action: 'cancelled',
          request_id: requestId.data,
        })
      }
      case 'no_request':
        return NextResponse.json({ success: true, action: 'no_request' })
      case 'account_inactive':
        return NextResponse.json({ error: 'Account is not active' }, { status: 403 })
      case 'not_found':
        return NextResponse.json({ error: 'Group not found' }, { status: 404 })
      case 'invalid':
        return NextResponse.json({ error: 'Invalid cancellation request' }, { status: 400 })
      default:
        logger.error('Atomic join-request cancellation returned an unknown status', {
          status: result.status,
        })
        return NextResponse.json({ error: 'Failed to cancel join request' }, { status: 500 })
    }
  },
  { name: 'group-join-request-cancel', rateLimit: 'write' }
)
