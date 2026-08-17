/**
 * @jest-environment node
 */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_target, key) => process.env[String(key)],
    }
  ),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
  V1_CRON_EXECUTION_NO_STORE_HEADERS,
} from '@/lib/cron/v1-execution-publication'
import { GET, POST } from '../route'

const originalCronSecret = process.env.CRON_SECRET
const routeSource = readFileSync(
  join(process.cwd(), 'app/api/cron/fetch-market-data/route.ts'),
  'utf8'
)

function requestWithSecret(method: 'GET' | 'POST', secret?: string): Request {
  return new Request('http://localhost/api/cron/fetch-market-data?type=ignored', {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
    body: method === 'POST' ? '{"type":"ignored"}' : undefined,
  })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('fetch-market-data V1 containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'fetch-market-data-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)(
    'returns no-store 401 before handling a noisy %s command',
    async (method, handler) => {
      for (const secret of [undefined, 'wrong-fetch-market-data-secret']) {
        const response = handler(requestWithSecret(method, secret))

        expect(response.status).toBe(401)
        await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
        expectNoStore(response)
      }
    }
  )

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)('returns no-store 410 for an authenticated %s command', async (method, handler) => {
    const response = handler(requestWithSecret(method, 'fetch-market-data-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('has no provider, database, pipeline, or request-parsing execution path', () => {
    expect(routeSource).toContain(
      'v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()'
    )
    expect(routeSource).not.toMatch(/\bfetch\(/)
    expect(routeSource).not.toContain('getSupabaseAdmin')
    expect(routeSource).not.toContain('PipelineLogger')
    expect(routeSource).not.toContain('request.url')
    expect(routeSource).not.toContain('searchParams')
  })
})
