/** @jest-environment node */

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
import { GET } from '../route'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/broadcast-trader-events/route.ts'),
  'utf8'
)
const metaMonitor = readFileSync(join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

function request(secret?: string): Request {
  return new Request('https://www.arenafi.org/api/cron/broadcast-trader-events', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe(
    'private, no-store, max-age=0, must-revalidate'
  )
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('retired followed-trader event broadcaster', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-trader-event-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it('authenticates before disclosing the retired endpoint', async () => {
    const response = GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectNoStore(response)
  })

  it('returns 410 for an authenticated request without evaluating or delivering events', async () => {
    const response = GET(request('retired-trader-event-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Retired cron route',
      code: 'TRADER_NOTIFICATIONS_NOT_PUBLISHED',
    })
    expectNoStore(response)
  })

  it('has no database, lock, pipeline, or delivery capability', () => {
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('acquireCronLock')
    expect(route).not.toContain('PipelineLogger')
    expect(route).not.toContain('getPushNotificationService')
    expect(route).not.toContain(".from('")
    expect(route).not.toContain('.rpc(')
    expect(metaMonitor).not.toContain("'broadcast-trader-events'")
    expect(pipelineLogger).not.toContain("'broadcast-trader-events'")
  })
})
