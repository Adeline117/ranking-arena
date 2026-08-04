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

import { POST } from './route'

describe('POST /api/trader/sync retired V1 contract', () => {
  it('always returns 410 and explains that account credentials are not profile proof', async () => {
    const response = await POST()

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        'Public first-party trader sync is unavailable in Arena V1. Account connections do not prove leaderboard-profile ownership.',
    })
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('contains no auth lookup, credential read, database write, or queue path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/trader/sync/route.ts'), 'utf8')

    expect(source).toContain('status: 410')
    expect(source).not.toMatch(/getSupabase|requireAuth|checkRateLimit|decrypt/)
    expect(source).not.toMatch(/enqueueFirstPartySync|publishProfile|\.from\(|\.rpc\(/)
  })
})
