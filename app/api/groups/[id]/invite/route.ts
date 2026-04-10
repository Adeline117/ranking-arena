import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { logger } from '@/lib/logger'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'

const log = createLogger('api:group-invite')

// SECURITY (2026-04-09, audit P0-SEC-3):
// 1. Removed static fallback 'default-invite-secret-for-build' which would
//    have allowed anyone to forge invite tokens in any deploy where INVITE_SECRET
//    happened to be unset.
// 2. Removed slice-of-service-role-key fallback — coupling invite signing to
//    your highest-privilege secret is a layering violation; if INVITE_SECRET
//    leaks via a forged token, attacker now has 32 chars of the service role.
// 3. Use full 32-byte HMAC (was truncated to 64 bits / 16 hex chars). 64 bits
//    is below modern brute-force threshold and made tokens forge-able with
//    enough public verify endpoint hammering.
// 4. Use crypto.timingSafeEqual on equal-length buffers instead of string ===,
//    eliminating the side-channel that could leak signature bytes via
//    response-latency probing of the public verify endpoint.
let _cachedInviteSecret: string | null = null
function getInviteSecret(): string {
  // Lazy-evaluate at first request, NOT at module load. Module-load throws
  // would break Vercel build because Next.js imports route modules during
  // build to extract metadata, before runtime envs are available.
  if (_cachedInviteSecret) return _cachedInviteSecret

  // Preferred path: explicit INVITE_SECRET env var (>= 32 chars).
  const explicit = process.env.INVITE_SECRET
  if (explicit && explicit.length >= 32) {
    _cachedInviteSecret = explicit
    return _cachedInviteSecret
  }

  // Fallback: derive from SUPABASE_SERVICE_ROLE_KEY via HKDF-SHA256.
  // HKDF is one-way, so an attacker who recovers an invite token cannot
  // reverse-derive the service role key. This is strictly better than the
  // previous `serviceKey.slice(0, 32)` which exposed the first 32 chars
  // of the highest-privilege secret directly.
  // The 'arena-invite-token-v1' info string namespaces this derivation —
  // changing it invalidates all existing invite tokens (intentional kill switch).
  const root = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!root || root.length < 32) {
    throw new Error(
      'INVITE_SECRET (or SUPABASE_SERVICE_ROLE_KEY as fallback) must be set ' +
      'to a strong (>=32 char) random value. Generate INVITE_SECRET with: ' +
      'openssl rand -hex 32',
    )
  }
  // Salt should be high-entropy and stable across deploys. Empty string is
  // acceptable for HKDF when info is non-empty (RFC 5869 §3.1).
  const derived = crypto
    .hkdfSync('sha256', Buffer.from(root, 'utf8'), Buffer.alloc(0), Buffer.from('arena-invite-token-v1', 'utf8'), 32)
  _cachedInviteSecret = Buffer.from(derived).toString('hex')
  return _cachedInviteSecret
}

type RouteContext = { params: Promise<{ id: string }> }

function generateInviteToken(groupId: string, expiresAt: number): string {
  const payload = `${groupId}:${expiresAt}`
  // Full 64-char hex HMAC-SHA256 (was truncated to 16 hex / 64 bits)
  const signature = crypto
    .createHmac('sha256', getInviteSecret())
    .update(payload)
    .digest('hex')
  return Buffer.from(`${payload}:${signature}`).toString('base64url')
}

export function verifyInviteToken(token: string): { groupId: string; valid: boolean } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString()
    const parts = decoded.split(':')
    if (parts.length !== 3) return { groupId: '', valid: false }

    const [groupId, expiresAtStr, signature] = parts
    const expiresAt = parseInt(expiresAtStr, 10)

    // Check expiry
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return { groupId, valid: false }

    // Verify signature with timing-safe compare
    const payload = `${groupId}:${expiresAtStr}`
    const expectedSig = crypto
      .createHmac('sha256', getInviteSecret())
      .update(payload)
      .digest('hex')

    // timingSafeEqual requires equal-length buffers. Hex output is fixed
    // 64 chars; if attacker supplies a different length, fail fast.
    if (signature.length !== expectedSig.length) return { groupId, valid: false }
    const sigBuf = Buffer.from(signature, 'utf8')
    const expectedBuf = Buffer.from(expectedSig, 'utf8')
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return { groupId, valid: false }

    return { groupId, valid: true }
  } catch {
    return { groupId: '', valid: false }
  }
}

// GET: Verify invite token (auth required — see security note below)
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  // Rate-limit verify hits per IP — defense in depth alongside auth check.
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResp) return rateLimitResp

  // SECURITY (2026-04-09, audit P0-SEC-3):
  // Require authenticated user to verify an invite. Previously this endpoint
  // was unauthenticated AND incremented used_count, so anyone holding a
  // valid token could burn the 50-use limit in a second via curl. The
  // frontend (app/(app)/groups/[id]/page.tsx:395) only calls verify when
  // userId is set (logged in), so adding auth here doesn't change the UX.
  const user = await getAuthUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: groupId } = await context.params
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('verify')

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    const result = verifyInviteToken(token)
    if (!result.valid || result.groupId !== groupId) {
      return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
    }

    // Check usage limits in group_invites table
    const supabase = getSupabaseAdmin()
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const { data: invite } = await supabase
      .from('group_invites')
      .select('id, used_count, max_uses')
      .eq('token_hash', tokenHash)
      .maybeSingle()

    if (invite) {
      if (invite.used_count >= invite.max_uses) {
        return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
      }

      // Increment used_count — now safe because endpoint requires auth +
      // is rate-limited per IP. Burnout-attack vector closed.
      await supabase
        .from('group_invites')
        .update({ used_count: invite.used_count + 1 })
        .eq('id', invite.id)
    }

    return NextResponse.json({ success: true, valid: true })
  } catch (error) {
    log.error('GET failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// POST: Generate invite link
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId } = await context.params

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // Check requester is owner/admin
    const { data: membership } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // Rate limit: max 10 invites per hour per user
    // KEEP 'exact' — rate-limit enforcement, scoped per-user + 1h
    // window. Must be accurate to block the 11th invite.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const { count: recentInviteCount } = await supabase
      .from('group_invites')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', user.id)
      .gte('created_at', oneHourAgo.toISOString())

    if ((recentInviteCount ?? 0) >= 10) {
      return NextResponse.json({ error: 'Maximum 10 invite links per hour' }, { status: 429 })
    }

    // Generate 7-day invite token
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const inviteToken = generateInviteToken(groupId, expiresAt)

    // Track invite in group_invites table
    await supabase.from('group_invites').insert({
      group_id: groupId,
      created_by: user.id,
      token_hash: crypto.createHash('sha256').update(inviteToken).digest('hex'),
      max_uses: 50,
      used_count: 0,
      expires_at: new Date(expiresAt).toISOString(),
    })

    const inviteUrl = `/groups/${groupId}?invite=${inviteToken}`

    return NextResponse.json({
      success: true,
      invite_url: inviteUrl,
      expires_at: new Date(expiresAt).toISOString(),
    })
  } catch (error: unknown) {
    logger.apiError('/api/groups/[id]/invite', error, {})
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
