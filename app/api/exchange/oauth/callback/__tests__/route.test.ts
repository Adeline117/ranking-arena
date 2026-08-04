import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn(
      (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
        status: init.status ?? 200,
        headers: new Map(Object.entries(init.headers ?? {})),
        json: async () => body,
      })
    ),
  },
}))

import { GET as authorize } from '../../authorize/route'
import { POST as refresh } from '../../refresh/route'
import { POST as callback } from '../route'

describe('exchange OAuth V1 retirement boundary', () => {
  it.each([
    ['authorize', authorize],
    ['callback', callback],
    ['refresh', refresh],
  ])(
    '%s always returns 410 with the API-key successor and no-store headers',
    async (_, handler) => {
      const response = await handler()

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Exchange OAuth is unavailable in Arena V1. Use read-only API key binding.',
        successor: '/api/trader/authorize',
      })
      expect(response.headers.get('Cache-Control')).toContain('no-store')
      expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
      expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
      expect(response.headers.get('Link')).toBe('</api/trader/authorize>; rel="successor-version"')
    }
  )

  it('contains no token exchange, encryption, state, or database writer', () => {
    for (const relativePath of [
      'app/api/exchange/oauth/authorize/route.ts',
      'app/api/exchange/oauth/callback/route.ts',
      'app/api/exchange/oauth/refresh/route.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8')

      expect(source).toContain('retiredExchangeOAuthResponse')
      expect(source).not.toMatch(/getSupabase|oauth_states|access_token|refresh_token/)
      expect(source).not.toMatch(/createCipher|createDecipher|\.from\(|\.rpc\(|fetch\(/)
    }
  })
})
