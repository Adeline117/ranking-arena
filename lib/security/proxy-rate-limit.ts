export type ProxyStrictRateLimitTier = 'health' | 'admin' | 'auth' | 'upload' | 'write'

export const PROXY_STRICT_RATE_LIMITS: Record<
  ProxyStrictRateLimitTier,
  { requests: number; window: `${number} s`; prefix: string }
> = {
  health: { requests: 200, window: '60 s', prefix: 'mw:rl:health' },
  admin: { requests: 60, window: '60 s', prefix: 'mw:rl:admin' },
  auth: { requests: 10, window: '60 s', prefix: 'mw:rl:auth' },
  upload: { requests: 20, window: '60 s', prefix: 'mw:rl:upload' },
  write: { requests: 30, window: '60 s', prefix: 'mw:rl:write' },
}

/**
 * Apply an extra strict tier only to sensitive API classes. Generic reads are
 * already protected by the 600 request/minute per-IP floor in proxy.ts. Giving
 * them a second 120/minute global bucket made a normal multi-device homepage
 * sweep (and users sharing a NAT) rate-limit each other.
 */
export function classifyProxyStrictRateLimit(
  pathname: string,
  method: string
): ProxyStrictRateLimitTier | null {
  if (
    pathname.startsWith('/api/cron/') ||
    pathname.startsWith('/api/webhook/') ||
    pathname.startsWith('/api/stripe/')
  ) {
    return null
  }
  if (pathname.startsWith('/api/health')) return 'health'
  if (pathname.startsWith('/api/admin/')) return 'admin'
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/settings/2fa/')) return 'auth'
  if (pathname.includes('/upload') || pathname.startsWith('/api/avatar')) return 'upload'
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return 'write'
  return null
}
