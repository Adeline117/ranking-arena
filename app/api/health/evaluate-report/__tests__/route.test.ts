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
const routeSource = readFileSync(
  join(process.cwd(), 'app/api/health/evaluate-report/route.ts'),
  'utf8'
)

function requestWithSecret(secret?: string): Request {
  return new Request('http://localhost/api/health/evaluate-report?score=0&source=ignored', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/health/evaluate-report V1 containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'health-evaluate-report-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([undefined, 'wrong-health-evaluate-report-secret'])(
    'returns no-store 401 before handling evaluator input for secret %s',
    async (secret) => {
      const response = GET(requestWithSecret(secret))

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )

  it('returns no-store 410 for an authenticated evaluator command', async () => {
    const response = GET(requestWithSecret('health-evaluate-report-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('has no evaluator state, alert, rate-limit, or request-parsing execution path', () => {
    expect(routeSource).toContain(
      'v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()'
    )
    expect(routeSource).not.toMatch(/request\.(?:nextUrl|url|json)\b/)
    expect(routeSource).not.toMatch(/\b(?:PipelineState|sendRateLimitedAlert|safeParseInt)\b/)
    expect(routeSource).not.toMatch(/\b(?:Ratelimit|checkRateLimit|RateLimitPresets)\b/)
    expect(routeSource).not.toMatch(/\bfetch\s*\(|\.(?:from|insert|update|upsert|delete)\(/)
  })
})
