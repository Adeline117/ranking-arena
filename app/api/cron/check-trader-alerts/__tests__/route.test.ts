/** @jest-environment node */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
        return process.env[String(key)]
      },
    }
  ),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GET, POST } from '../route'

const route = readFileSync(join(process.cwd(), 'app/api/cron/check-trader-alerts/route.ts'), 'utf8')
const monitor = readFileSync(join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

function request(method: 'GET' | 'POST', secret?: string): Request {
  return new Request('https://www.arenafi.org/api/cron/check-trader-alerts', {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

describe('retired trader-alert cron route', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-trader-alert-cron-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)(
    'authenticates before retiring an authenticated %s request',
    async (method, handler) => {
      const response = handler(request(method))

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)(
    'returns 410 without execution for an authenticated %s request',
    async (method, handler) => {
      const response = handler(request(method, 'retired-trader-alert-cron-test-secret'))

      expect(response.status).toBe(410)
      await expect(response.json()).resolves.toMatchObject({
        error: 'Retired cron route',
        code: 'TRADER_ALERTS_NOT_PUBLISHED',
      })
      expectNoStore(response)
    }
  )

  it('has no evaluator, delivery, pipeline, or dead-man path', () => {
    expect(route).not.toContain('runTraderAlerts')
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('PipelineLogger')
    expect(route).not.toContain('getPushNotificationService')
    expect(route).not.toContain('sendEmail')
    expect(route).not.toContain('createHash')
    expect(monitor).not.toContain("'check-trader-alerts'")
    expect(pipelineLogger).not.toContain("'check-trader-alerts'")
  })
})

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe(
    'private, no-store, max-age=0, must-revalidate'
  )
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}
