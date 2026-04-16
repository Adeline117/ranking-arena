/**
 * Shared utility for extracting the authenticated user from a request.
 * Supports both Bearer token and cookie-based auth.
 *
 * Consolidates the pattern duplicated across 9+ API routes.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createClient } from '@supabase/supabase-js'
import type { User } from '@supabase/supabase-js'
import { authLogger } from '@/lib/utils/logger'

// ---------------------------------------------------------------------------
// Auth failure observability
// ---------------------------------------------------------------------------
//
// Previously, any auth error (expired JWT, malformed token, Supabase
// auth-service outage, missing env) collapsed into `{ user: null, error }`
// and most callers only checked `!user`. So an auth-service outage looked
// identical to a logged-out user — we'd see 401s pile up on the client
// with no signal that auth was broken.
//
// Now we classify each miss (expected `no_auth` vs exceptional `jwt_expired`,
// `invalid_token`, `supabase_error`, `config_missing`) and keep a rolling
// in-memory counter so /api/health/detailed can surface elevated rates.
// Expected "not authenticated" hits are NOT counted (they're user-signed-out
// requests and would drown out the signal).

type AuthFailureReason =
  | 'jwt_expired'
  | 'invalid_token'
  | 'supabase_error'
  | 'config_missing'
  | 'cookie_parse_error'

interface AuthFailureStat {
  count: number
  lastMessage: string
  lastAt: number
}

const _authFailureStats = new Map<AuthFailureReason, AuthFailureStat>()

/** Record an auth failure for observability. */
function recordAuthFailure(reason: AuthFailureReason, message: string): void {
  const existing = _authFailureStats.get(reason) ?? { count: 0, lastMessage: '', lastAt: 0 }
  existing.count++
  existing.lastMessage = message.slice(0, 200)
  existing.lastAt = Date.now()
  _authFailureStats.set(reason, existing)
  // Log at warn so an exploding error rate shows up in production logs.
  authLogger.warn(`[extractUser] ${reason}`, { reason, message: existing.lastMessage })
}

/** Classify a Supabase auth error message into a reason code. */
function classifyAuthError(message: string | null | undefined): AuthFailureReason {
  if (!message) return 'invalid_token'
  const m = message.toLowerCase()
  if (m.includes('jwt expired') || m.includes('jwtexpired')) return 'jwt_expired'
  if (m.includes('invalid') || m.includes('bad jwt') || m.includes('signature')) return 'invalid_token'
  // Supabase service errors (500/timeout/network)
  if (m.includes('fetch failed') || m.includes('etimedout') || m.includes('econnreset') ||
      m.includes('network') || m.includes('503') || m.includes('502') || m.includes('500')) {
    return 'supabase_error'
  }
  return 'invalid_token'
}

/**
 * Snapshot of auth failure counters since process start. Useful for
 * /api/health/detailed to surface elevated rates (e.g. a Supabase auth
 * outage shows up as spiking `supabase_error` count).
 */
export function getAuthFailureStats(): Record<AuthFailureReason, {
  count: number
  lastMessage: string
  lastAt: string
}> {
  const out = {} as Record<AuthFailureReason, {
    count: number
    lastMessage: string
    lastAt: string
  }>
  for (const [reason, s] of _authFailureStats.entries()) {
    out[reason] = {
      count: s.count,
      lastMessage: s.lastMessage,
      lastAt: new Date(s.lastAt).toISOString(),
    }
  }
  return out
}

export async function extractUserFromRequest(request: Request): Promise<{
  user: User | null
  error: string | null
}> {
  const authHeader = request.headers.get('authorization')

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    try {
      const { data, error } = await getSupabaseAdmin().auth.getUser(token)
      if (error) recordAuthFailure(classifyAuthError(error.message), error.message)
      return { user: data?.user ?? null, error: error?.message ?? null }
    } catch (err) {
      // Network error / unexpected exception talking to Supabase Auth.
      const message = err instanceof Error ? err.message : String(err)
      recordAuthFailure('supabase_error', message)
      return { user: null, error: message }
    }
  }

  // Fallback to cookie auth
  const cookieHeader = request.headers.get('cookie') || ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!anonKey || !supabaseUrl) {
    recordAuthFailure('config_missing', 'NEXT_PUBLIC_SUPABASE_URL or _ANON_KEY missing')
    return { user: null, error: 'Server configuration error' }
  }

  try {
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { cookie: cookieHeader } },
      auth: { persistSession: false, detectSessionInUrl: false },
    })
    const { data, error } = await supabase.auth.getUser()
    // Only record exceptional failures. A plain "not authenticated" (no
    // cookie, no bearer) returns user=null without an error — that's normal
    // user-signed-out traffic and would drown out the signal if we counted it.
    if (error) recordAuthFailure(classifyAuthError(error.message), error.message)
    return { user: data?.user ?? null, error: error?.message ?? null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordAuthFailure('supabase_error', message)
    return { user: null, error: message }
  }
}
