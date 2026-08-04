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

import { POST } from '../route'

describe('POST /api/exchange/connect retired contract', () => {
  it('always returns 410 with the sole supported successor and no-store headers', async () => {
    const response = await POST()

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'This exchange connection endpoint is retired. Use /api/trader/authorize.',
      successor: '/api/trader/authorize',
    })
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Link')).toBe('</api/trader/authorize>; rel="successor-version"')
  })

  it('contains no authentication, credential validation, or database path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/exchange/connect/route.ts'), 'utf8')

    expect(source).toContain('status: 410')
    expect(source).toContain("successor: '/api/trader/authorize'")
    expect(source).not.toMatch(/getSupabase|getAuthUser|requireAuth|withApiMiddleware/)
    expect(source).not.toMatch(/validateExchange|encrypt|\.from\(|\.rpc\(/)
  })
})
