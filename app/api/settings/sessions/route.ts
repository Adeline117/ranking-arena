/**
 * Sessions Management API
 * GET: List active sessions for the current user
 * DELETE: Revoke every real Supabase session except the current one
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getProvisioningAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

interface SessionRow {
  id: string
  user_id: string
  device_info: string | null
  ip_address: string | null
  created_at: string
  last_active_at: string | null
  revoked: boolean
}

export async function GET(request: NextRequest) {
  try {
    const user = await getProvisioningAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const supabase = getSupabaseAdmin()

    // Fetch active (non-revoked) sessions for this user
    const { data: sessions, error: queryError } = await supabase
      .from('login_sessions')
      .select('id, user_id, device_info, ip_address, created_at, last_active_at, revoked')
      .eq('user_id', user.id)
      .eq('revoked', false)
      .order('last_active_at', { ascending: false })

    if (queryError) {
      logger.error('[Sessions] Query error:', queryError)
      return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 })
    }

    const typedSessions = sessions as SessionRow[] | null

    return NextResponse.json({
      sessions: (typedSessions ?? []).map((session) => ({
        id: session.id,
        deviceInfo: session.device_info,
        ipAddress: session.ip_address,
        createdAt: session.created_at,
        lastActiveAt: session.last_active_at,
      })),
    })
  } catch (error: unknown) {
    logger.error('[Sessions] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation for mutation
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Expected all: true' }, { status: 400 })
    }
    const fields = body as Record<string, unknown>
    if (
      Object.keys(fields).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(fields, 'all') ||
      fields.all !== true
    ) {
      return NextResponse.json({ error: 'Expected all: true' }, { status: 400 })
    }

    const bearerMatch = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)
    if (!bearerMatch) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // `login_sessions` is only legacy display metadata and is not consulted by
    // Supabase Auth. Marking those rows revoked therefore never terminated a
    // refresh token. Ask GoTrue to revoke the authenticated subject's actual
    // sessions, preserving only the bearer session that made this request.
    const supabase = getSupabaseAdmin()
    const { error: revokeError } = await supabase.auth.admin.signOut(bearerMatch[1], 'others')
    if (revokeError) {
      logger.error('[Sessions] Supabase session revocation failed', {
        userId: user.id,
        code: revokeError.code,
      })
      return NextResponse.json({ error: 'Failed to revoke other sessions' }, { status: 503 })
    }

    const response = NextResponse.json({ success: true, revokedOthers: true })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error: unknown) {
    logger.error('[Sessions] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
