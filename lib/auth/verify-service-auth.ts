/**
 * Shared service authentication for cron jobs and admin endpoints.
 * Uses timing-safe comparison to prevent timing side-channel attacks.
 */

import { timingSafeEqual } from 'crypto'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { isProfileSuspended } from '@/lib/auth/profile-suspension'

export type AdminAuthResult =
  | { status: 'authorized' }
  | { status: 'invalid' }
  | { status: 'unavailable'; error: unknown }

interface VerifyAdminAuthOptions {
  signal?: AbortSignal
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify cron secret from Authorization header.
 * Uses timing-safe comparison.
 */
export function verifyCronSecret(request: Request): boolean {
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false
  const authHeader = request.headers.get('authorization')
  if (!authHeader) return false
  return safeCompare(authHeader, `Bearer ${cronSecret}`)
}

/**
 * Verify service auth — accepts CRON_SECRET (Bearer) or INTERNAL_API_KEY (x-internal-key).
 * Uses timing-safe comparison for both.
 */
export function verifyServiceAuth(request: Request): boolean {
  if (verifyCronSecret(request)) return true

  const internalKey = request.headers.get('x-internal-key')
  const configuredInternalKey = process.env.INTERNAL_API_KEY
  if (configuredInternalKey && internalKey && safeCompare(internalKey, configuredInternalKey)) {
    return true
  }

  return false
}

function isInvalidCredentialError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  if (
    ['AuthSessionMissingError', 'AuthInvalidJwtError', 'AuthInvalidCredentialsError'].includes(name)
  ) {
    return true
  }

  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : ''
  if (
    [
      'bad_jwt',
      'invalid_jwt',
      'no_authorization',
      'user_not_found',
      'session_not_found',
      'session_expired',
      'user_banned',
      'invalid_credentials',
    ].includes(code)
  ) {
    return true
  }

  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : ''
  return (
    message.includes('invalid jwt') ||
    message.includes('jwt expired') ||
    message.includes('invalid token') ||
    message.includes('auth session missing') ||
    message.includes('session not found') ||
    message.includes('user not found')
  )
}

/**
 * Verify admin access while preserving the distinction between invalid
 * credentials and an unavailable authentication authority.
 */
export async function verifyAdminAuthResult(
  request: Request,
  options: VerifyAdminAuthOptions = {}
): Promise<AdminAuthResult> {
  // Check cron/service secret first (fast path)
  if (verifyCronSecret(request)) return { status: 'authorized' }

  // Check x-admin-token header (prefer ADMIN_API_KEY, fall back to CRON_SECRET)
  const adminApiKey = process.env.ADMIN_API_KEY || env.CRON_SECRET
  if (adminApiKey) {
    const adminToken = request.headers.get('x-admin-token')
    if (adminToken && safeCompare(adminToken, adminApiKey)) return { status: 'authorized' }
  }

  // Check admin user JWT — must pass BOTH DB role AND email whitelist in production
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7)
      const {
        data: { user },
        error,
      } = await getSupabaseAdmin().auth.getUser(token)
      if (error) {
        return isInvalidCredentialError(error)
          ? { status: 'invalid' }
          : { status: 'unavailable', error }
      }
      if (!user) return { status: 'invalid' }

      const profileQuery = getSupabaseAdmin()
        .from('user_profiles')
        .select('role, banned_at, deleted_at, is_banned, ban_expires_at')
        .eq('id', user.id)
      const { data: profile, error: profileError } = await (
        options.signal ? profileQuery.abortSignal(options.signal) : profileQuery
      ).maybeSingle()
      if (profileError) return { status: 'unavailable', error: profileError }
      if (!profile || isProfileSuspended(profile)) return { status: 'invalid' }
      const isAdminByRole = profile?.role === 'admin'
      if (!isAdminByRole) return { status: 'invalid' }

      // Production: enforce email whitelist (same as lib/admin/auth.ts)
      const adminEmails = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
      if (process.env.NODE_ENV === 'production') {
        if (!user.email || !adminEmails.includes(user.email)) return { status: 'invalid' }
      }
      return { status: 'authorized' }
    } catch (error) {
      return { status: 'unavailable', error }
    }
  }

  return { status: 'invalid' }
}

/**
 * Backward-compatible boolean wrapper for existing admin routes.
 */
export async function verifyAdminAuth(request: Request): Promise<boolean> {
  return (await verifyAdminAuthResult(request)).status === 'authorized'
}

export { safeCompare }
