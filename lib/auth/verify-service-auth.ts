/**
 * Shared service authentication for cron jobs and admin endpoints.
 * Uses timing-safe comparison to prevent timing side-channel attacks.
 */

import { timingSafeEqual } from 'crypto'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'

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

/**
 * Verify admin access — accepts CRON_SECRET, x-admin-token, or admin user JWT.
 * For use in admin dashboard API endpoints that need to be callable from both
 * cron jobs and the admin UI.
 */
export async function verifyAdminAuth(request: Request): Promise<boolean> {
  // Check cron/service secret first (fast path)
  if (verifyCronSecret(request)) return true

  const cronSecret = env.CRON_SECRET
  if (cronSecret) {
    const adminToken = request.headers.get('x-admin-token')
    if (adminToken && safeCompare(adminToken, cronSecret)) return true
  }

  // Check admin user JWT
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7)
      const { data: { user }, error } = await getSupabaseAdmin().auth.getUser(token)
      if (error || !user) return false
      const { data: profile } = await getSupabaseAdmin()
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      return profile?.role === 'admin'
    } catch {
      return false
    }
  }

  return false
}

export { safeCompare }
