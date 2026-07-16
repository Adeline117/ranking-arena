import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { generateInviteToken, hashInviteToken, verifyInviteToken } from '@/lib/groups/invite-tokens'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { createLogger } from '@/lib/utils/logger'

export { verifyInviteToken } from '@/lib/groups/invite-tokens'

const log = createLogger('api:group-invite')
const GroupIdSchema = z.string().uuid()
const RevokeBodySchema = z.object({ invite_id: z.string().uuid() }).strict()
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const INVITE_MAX_USES = 50
const TOKEN_COLLISION_RETRIES = 3

type AtomicInviteResult = {
  status: string
  invite_id?: string
  expires_at?: string
  required_score?: number
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readAtomicInviteResult(value: unknown): AtomicInviteResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (typeof result.status !== 'string') return null
  if (result.invite_id !== undefined && !GroupIdSchema.safeParse(result.invite_id).success) {
    return null
  }
  if (result.expires_at !== undefined && !isTimestamp(result.expires_at)) return null
  if (
    result.required_score !== undefined &&
    (typeof result.required_score !== 'number' ||
      !Number.isFinite(result.required_score) ||
      result.required_score < 0)
  ) {
    return null
  }

  return {
    status: result.status,
    ...(typeof result.invite_id === 'string' ? { invite_id: result.invite_id } : {}),
    ...(isTimestamp(result.expires_at) ? { expires_at: result.expires_at } : {}),
    ...(typeof result.required_score === 'number' ? { required_score: result.required_score } : {}),
  }
}

/** Extract and validate the group id from the URL path. */
function readGroupId(url: string): string | null {
  try {
    const pathParts = new URL(url).pathname.split('/')
    const groupsIndex = pathParts.indexOf('groups')
    const parsed = GroupIdSchema.safeParse(pathParts[groupsIndex + 1])
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function inspectionResponse(result: AtomicInviteResult | null) {
  if (!result) {
    return NextResponse.json({ error: 'Failed to verify invite' }, { status: 500 })
  }

  switch (result.status) {
    case 'valid':
      return NextResponse.json({ success: true, valid: true })
    case 'already_member':
      return NextResponse.json({ success: true, valid: true, already_member: true })
    case 'invite_already_used':
      return NextResponse.json(
        { error: 'This invite has already been used by this account', code: 'INVITE_ALREADY_USED' },
        { status: 409 }
      )
    case 'account_inactive':
      return NextResponse.json({ error: 'Account is not active' }, { status: 403 })
    case 'banned':
      return NextResponse.json(
        { error: 'You are banned from this group', code: 'BANNED' },
        { status: 403 }
      )
    case 'score_too_low':
      return NextResponse.json(
        {
          error: `This group requires Arena Score of ${result.required_score ?? 0}+`,
          code: 'SCORE_TOO_LOW',
          required_score: result.required_score ?? 0,
        },
        { status: 403 }
      )
    case 'verified_only':
      return NextResponse.json(
        {
          error: 'This group is restricted to verified traders only',
          code: 'VERIFIED_ONLY',
        },
        { status: 403 }
      )
    case 'premium_required':
      return NextResponse.json(
        { error: 'Pro membership is required', code: 'PREMIUM_REQUIRED' },
        { status: 403 }
      )
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json({ error: 'This group has been dissolved' }, { status: 409 })
    case 'invalid':
    case 'invalid_invite':
    case 'invite_required':
      return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
    default:
      log.error('Atomic invite inspection returned an unknown status', { status: result.status })
      return NextResponse.json({ error: 'Failed to verify invite' }, { status: 500 })
  }
}

function creationFailureResponse(result: AtomicInviteResult | null) {
  if (!result) {
    return NextResponse.json({ error: 'Failed to generate invite link' }, { status: 500 })
  }

  switch (result.status) {
    case 'rate_limited':
      return NextResponse.json({ error: 'Maximum 10 invite links per hour' }, { status: 429 })
    case 'account_inactive':
    case 'forbidden':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json({ error: 'This group has been dissolved' }, { status: 409 })
    case 'invalid':
      return NextResponse.json({ error: 'Invalid invite request' }, { status: 400 })
    default:
      log.error('Atomic invite creation returned an unknown status', { status: result.status })
      return NextResponse.json({ error: 'Failed to generate invite link' }, { status: 500 })
  }
}

// GET validates both the signed token and its database state. Inspection is a
// read-only RPC: refreshing or prefetching this endpoint never consumes a use.
export const GET = withAuth(
  async ({ user, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = readGroupId(request.url)
    if (!groupId) {
      return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
    }

    const token = new URL(request.url).searchParams.get('verify')
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    const verified = verifyInviteToken(token)
    if (!verified.valid || verified.groupId !== groupId) {
      return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
    }

    const { data, error } = await getSupabaseAdmin().rpc(
      'inspect_group_invite_atomic' as never,
      {
        p_actor_id: user.id,
        p_group_id: groupId,
        p_token_hash: hashInviteToken(token),
        p_pro_free_promo: PRO_FREE_PROMO,
      } as never
    )

    if (error) {
      log.error('Atomic invite inspection failed', error)
      return NextResponse.json({ error: 'Failed to verify invite' }, { status: 500 })
    }

    const result = readAtomicInviteResult(data)
    if (!result) {
      log.error('Atomic invite inspection returned an invalid result', { data })
    }
    return inspectionResponse(result)
  },
  { name: 'group-invite-verify', rateLimit: 'read' }
)

// POST creates the invite and its audit evidence in one database transaction.
// A random nonce makes token collisions negligible; bounded retries handle the
// database uniqueness contract without double-spending the hourly quota.
export const POST = withAuth(
  async ({ user, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = readGroupId(request.url)
    if (!groupId) {
      return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
    }

    const expiresAt = Date.now() + INVITE_LIFETIME_MS
    const admin = getSupabaseAdmin()

    for (let attempt = 0; attempt < TOKEN_COLLISION_RETRIES; attempt += 1) {
      let inviteToken: string
      try {
        inviteToken = generateInviteToken(groupId, expiresAt)
      } catch (error) {
        log.error('Invite token generation failed', error)
        return NextResponse.json({ error: 'Failed to generate invite link' }, { status: 500 })
      }

      const { data, error } = await admin.rpc(
        'create_group_invite_atomic' as never,
        {
          p_actor_id: user.id,
          p_group_id: groupId,
          p_token_hash: hashInviteToken(inviteToken),
          p_expires_at: new Date(expiresAt).toISOString(),
          p_max_uses: INVITE_MAX_USES,
        } as never
      )

      if (error) {
        log.error('Atomic invite creation failed', error)
        return NextResponse.json({ error: 'Failed to generate invite link' }, { status: 500 })
      }

      const result = readAtomicInviteResult(data)
      if (!result) {
        log.error('Atomic invite creation returned an invalid result', { data })
        return creationFailureResponse(null)
      }
      if (result.status === 'token_conflict') continue
      if (result.status !== 'created') return creationFailureResponse(result)
      if (
        result.invite_id === undefined ||
        result.expires_at === undefined ||
        Date.parse(result.expires_at) !== expiresAt
      ) {
        log.error('Atomic invite creation returned incomplete evidence', { result })
        return creationFailureResponse(null)
      }

      return NextResponse.json({
        success: true,
        invite_url: `/groups/${groupId}?invite=${inviteToken}`,
        expires_at: result.expires_at,
      })
    }

    log.error('Invite token uniqueness retries were exhausted')
    return NextResponse.json({ error: 'Failed to generate invite link' }, { status: 503 })
  },
  { name: 'group-invite-create', rateLimit: 'write' }
)

// DELETE soft-revokes an invite through the same database authority. Repeating
// the request is intentionally idempotent and never deletes redemption proof.
export const DELETE = withAuth(
  async ({ user, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = readGroupId(request.url)
    if (!groupId) {
      return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
    }

    const parsedBody = RevokeBodySchema.safeParse(await request.json().catch(() => null))
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'A valid invite ID is required' }, { status: 400 })
    }

    const { data, error } = await getSupabaseAdmin().rpc(
      'revoke_group_invite_atomic' as never,
      {
        p_actor_id: user.id,
        p_group_id: groupId,
        p_invite_id: parsedBody.data.invite_id,
      } as never
    )

    if (error) {
      log.error('Atomic invite revocation failed', error)
      return NextResponse.json({ error: 'Failed to revoke invite' }, { status: 500 })
    }

    const result = readAtomicInviteResult(data)
    switch (result?.status) {
      case 'revoked':
        return NextResponse.json({ success: true })
      case 'already_revoked':
        return NextResponse.json({ success: true, already_revoked: true })
      case 'invite_not_found':
        return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
      case 'not_found':
        return NextResponse.json({ error: 'Group not found' }, { status: 404 })
      case 'account_inactive':
      case 'forbidden':
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      case 'invalid':
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      default:
        if (!result) {
          log.error('Atomic invite revocation returned an invalid result', { data })
        } else {
          log.error('Atomic invite revocation returned an unknown status', {
            status: result.status,
          })
        }
        return NextResponse.json({ error: 'Failed to revoke invite' }, { status: 500 })
    }
  },
  { name: 'group-invite-revoke', rateLimit: 'write' }
)
