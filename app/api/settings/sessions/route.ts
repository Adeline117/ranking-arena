/**
 * Sessions Management API
 * GET: List active sessions for the current user
 * DELETE: Revoke a specific session or all sessions except current
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
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

interface DeleteRequestBody {
  sessionId?: string
  all?: boolean
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
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

    const supabase = getSupabaseAdmin()

    const body = (await request.json()) as DeleteRequestBody
    const { sessionId, all } = body

    if (!sessionId && !all) {
      return NextResponse.json(
        { error: 'Provide either sessionId or all: true' },
        { status: 400 }
      )
    }

    // Determine the current session ID from the token
    // The current session is identified by the token being used to make this request
    const currentSessionHeader = request.headers.get('x-session-id')

    if (sessionId) {
      // Revoke a specific session
      const { error: revokeError } = await supabase
        .from('login_sessions')
        .update({ revoked: true })
        .eq('id', sessionId)
        .eq('user_id', user.id)

      if (revokeError) {
        logger.error('[Sessions] Revoke error:', revokeError)
        return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 })
      }

      return NextResponse.json({ success: true, revoked: sessionId })
    }

    if (all) {
      // Revoke all sessions except the current one
      let query = supabase
        .from('login_sessions')
        .update({ revoked: true })
        .eq('user_id', user.id)
        .eq('revoked', false)

      if (currentSessionHeader) {
        query = query.neq('id', currentSessionHeader)
      }

      const { error: revokeAllError } = await query

      if (revokeAllError) {
        logger.error('[Sessions] Revoke all error:', revokeAllError)
        return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 })
      }

      return NextResponse.json({ success: true, revokedAll: true })
    }

    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  } catch (error: unknown) {
    logger.error('[Sessions] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
