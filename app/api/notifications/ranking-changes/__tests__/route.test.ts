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
import { POST } from '../route'

const route = readFileSync(
  join(process.cwd(), 'app/api/notifications/ranking-changes/route.ts'),
  'utf8'
)
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

function request(secret?: string): Request {
  return new Request('https://www.arenafi.org/api/notifications/ranking-changes', {
    method: 'POST',
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

describe('retired ranking-change notification trigger', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-ranking-change-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it('authenticates before disclosing the retired endpoint', async () => {
    const response = POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectNoStore(response)
  })

  it('returns 410 for an authenticated request without evaluating or writing notifications', async () => {
    const response = POST(request('retired-ranking-change-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Retired notification trigger',
      code: 'TRADER_NOTIFICATIONS_NOT_PUBLISHED',
    })
    expectNoStore(response)
  })

  it('has no ranking reader, pipeline, or notification write capability', () => {
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('PipelineLogger')
    expect(route).not.toContain(".from('")
    expect(route).not.toContain('.insert(')
    expect(pipelineLogger).not.toContain("'ranking-change-notifications'")
  })
})
