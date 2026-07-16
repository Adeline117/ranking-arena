/** @jest-environment node */

import { classifyProxyStrictRateLimit } from '../proxy-rate-limit'

describe('classifyProxyStrictRateLimit', () => {
  it('leaves generic reads to the generous global IP floor', () => {
    expect(classifyProxyStrictRateLimit('/api/sources/visible', 'GET')).toBeNull()
    expect(classifyProxyStrictRateLimit('/api/traders', 'GET')).toBeNull()
  })

  it.each([
    ['/api/admin/users', 'GET', 'admin'],
    ['/api/auth/siwe/nonce', 'GET', 'auth'],
    ['/api/settings/2fa/setup', 'POST', 'auth'],
    ['/api/avatar', 'POST', 'upload'],
    ['/api/posts/123/like', 'POST', 'write'],
  ])('keeps %s %s in the %s strict tier', (pathname, method, expected) => {
    expect(classifyProxyStrictRateLimit(pathname, method)).toBe(expected)
  })

  it.each(['/api/cron/warm-cache', '/api/webhook/provider', '/api/stripe/webhook'])(
    'keeps service-auth route %s outside the proxy tier',
    (pathname) => {
      expect(classifyProxyStrictRateLimit(pathname, 'POST')).toBeNull()
    }
  )
})
