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
const route = readFileSync(join(root, 'app/api/cron/cleanup-violations/route.ts'), 'utf8')
const vercel = readFileSync(join(root, 'vercel.json'), 'utf8')
const monitor = readFileSync(join(root, 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(root, 'lib/services/pipeline-logger.ts'), 'utf8')

function request(method: 'GET' | 'POST', secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/cleanup-violations', {
    method,
    headers,
  })
}

describe('retired historical violation cleanup', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-violation-cleanup-secret'
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
    'returns 410 for an authenticated %s without touching data',
    async (method, handler) => {
      const response = handler(request(method, 'retired-violation-cleanup-secret'))

      expect(response.status).toBe(410)
      expect(response.headers.get('cache-control')).toBe(
        'private, no-store, max-age=0, must-revalidate'
      )
      expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
      expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({
        error: 'Retired cron route',
        replacement: 'none; operator review required',
      })
    }
  )

  it('has no mutation path, schedule, or dead-man expectation', () => {
    expect(route).not.toContain('withCron')
    expect(route).not.toContain('supabase')
    expect(route).not.toContain('.rpc(')
    expect(route).not.toContain('cleanup_all_data_violations')
    expect(route).not.toContain('cleanup_snapshot_violations')
    expect(route).not.toContain('pipeline_rejected_writes')
    expect(route).toContain('There is no automatic repair replacement')
    expect(vercel).not.toContain('/api/cron/cleanup-violations')
    expect(monitor).not.toContain('cleanup-violations')
    expect(pipelineLogger).not.toContain("'cleanup-violations'")
  })
})
