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
import { GET } from '../route'

const originalCronSecret = process.env.CRON_SECRET
const routeSource = readFileSync(join(process.cwd(), 'app/api/cron/smoke-test/route.ts'), 'utf8')

function requestWithSecret(secret?: string): Request {
  return new Request('http://localhost/api/cron/smoke-test?target=ignored', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('smoke-test V1 containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'smoke-test-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([undefined, 'wrong-smoke-test-secret'])(
    'returns no-store 401 before handling smoke-test parameters for secret %s',
    async (secret) => {
      const response = GET(requestWithSecret(secret))

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )

  it('returns no-store 410 for an authenticated smoke-test command', async () => {
    const response = GET(requestWithSecret('smoke-test-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('has no page fetch, alert, pipeline, or request-parsing execution path', () => {
    expect(routeSource).toContain(
      'v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()'
    )
    expect(routeSource).not.toMatch(/\bfetch\(/)
    expect(routeSource).not.toContain('sendRateLimitedAlert')
    expect(routeSource).not.toContain('PipelineLogger')
    expect(routeSource).not.toContain('request.url')
    expect(routeSource).not.toContain('process.env')
  })
})
