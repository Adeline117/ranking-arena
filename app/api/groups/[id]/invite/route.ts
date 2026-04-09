import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { logger } from '@/lib/logger'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

const log = createLogger('api:group-invite')

const INVITE_SECRET = process.env.INVITE_SECRET || (process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 32) ?? 'default-invite-secret-for-build')

type RouteContext = { params: Promise<{ id: string }> }

function generateInviteToken(groupId: string, expiresAt: number): string {
  const payload = `${groupId}:${expiresAt}`
  const signature = crypto
    .createHmac('sha256', INVITE_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 16)
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
    if (Date.now() > expiresAt) return { groupId, valid: false }

    // Verify signature
    const payload = `${groupId}:${expiresAtStr}`
    const expectedSig = crypto
      .createHmac('sha256', INVITE_SECRET)
      .update(payload)
      .digest('hex')
      .slice(0, 16)

    if (signature !== expectedSig) return { groupId, valid: false }

    return { groupId, valid: true }
  } catch {
    return { groupId: '', valid: false }
  }
}

// GET: Verify invite token
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

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

      // Increment used_count on successful verification
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
