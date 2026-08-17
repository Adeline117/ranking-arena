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
    ['/api/posts/123/like', 'POST', 'write'],
  ])('keeps %s %s in the %s strict tier', (pathname, method, expected) => {
    expect(classifyProxyStrictRateLimit(pathname, method)).toBe(expected)
  })

  it('does not classify the retired avatar compatibility paths', () => {
    expect(classifyProxyStrictRateLimit('/api/avatar', 'GET')).toBeNull()
    expect(classifyProxyStrictRateLimit('/api/v1/avatar', 'GET')).toBeNull()
  })

  it.each(['/api/avatar-metadata', '/api/avatar/metadata'])(
    'keeps adjacent avatar paths in the strict upload tier: %s',
    (pathname) => {
      expect(classifyProxyStrictRateLimit(pathname, 'GET')).toBe('upload')
    }
  )

  it.each(['/api/cron/warm-cache', '/api/webhook/provider', '/api/stripe/webhook'])(
    'keeps service-auth route %s outside the proxy tier',
    (pathname) => {
      expect(classifyProxyStrictRateLimit(pathname, 'POST')).toBeNull()
    }
  )
})
