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

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/compute-derived-metrics/route.ts'),
  'utf8'
)
const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
const monitor = readFileSync(join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

function request(method: 'GET' | 'POST', secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/compute-derived-metrics', {
    method,
    headers,
  })
}

describe('retired derived metrics writer', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-route-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it('authenticates before disclosing the retired route', async () => {
    const response = GET(request('GET'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)(
    'returns 410 for an authenticated %s without touching data',
    async (method, handler) => {
      const response = handler(request(method, 'retired-route-test-secret'))

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toEqual({
        error: 'Retired cron route',
        replacement: 'compute-leaderboard atomic generation',
      })
    }
  )

  it('has no mutation path, schedule, or dead-man expectation', () => {
    expect(route).not.toContain('supabase.rpc')
    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain("from('trader_daily_snapshots')")
    expect(vercel).not.toContain('/api/cron/compute-derived-metrics')
    expect(monitor).not.toContain("'compute-derived-metrics'")
    expect(pipelineLogger).not.toContain("'compute-derived-metrics'")
  })
})
