/**
 * @jest-environment node
 */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_target, key) => (key === 'CRON_SECRET' ? process.env.CRON_SECRET : undefined),
    }
  ),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const root = process.cwd()
const route = readFileSync(join(root, 'app/api/cron/scan-data-quality/route.ts'), 'utf8')
const vercel = readFileSync(join(root, 'vercel.json'), 'utf8')

function request(method: 'GET' | 'POST', secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/scan-data-quality', {
    method,
    headers,
  })
}

describe('retired unversioned data-quality scanner', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-quality-scanner-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)('authenticates before disclosing the retired %s route', async (method, handler) => {
    const response = handler(request(method))

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0, must-revalidate'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)(
    'returns 410 for an authenticated %s without invoking the unversioned RPC',
    async (method, handler) => {
      const response = handler(request(method, 'retired-quality-scanner-secret'))

      expect(response.status).toBe(410)
      expect(response.headers.get('cache-control')).toBe(
        'private, no-store, max-age=0, must-revalidate'
      )
      expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
      expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({
        error: 'Retired cron route',
        replacement: 'none; exact versioned scanner required',
      })
    }
  )

  it('has no RPC, data client, alert path, or schedule', () => {
    expect(route).not.toContain('scan_data_quality_anomalies')
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('withCron')
    expect(route).not.toContain('sendRateLimitedAlert')
    expect(vercel).not.toContain('/api/cron/scan-data-quality')
  })
})
