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

const route = readFileSync(join(process.cwd(), 'app/api/cron/weekly-digest/route.ts'), 'utf8')
const metaMonitor = readFileSync(join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

function request(secret?: string): Request {
  return new Request('https://www.arenafi.org/api/cron/weekly-digest', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('retired customer weekly digest cron', () => {
  const originalCronSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'retired-weekly-digest-test-secret'
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

  it('returns 410 for an authenticated request without reading subscribers or sending email', async () => {
    const response = GET(request('retired-weekly-digest-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Retired cron route',
      code: 'TRADER_NOTIFICATIONS_NOT_PUBLISHED',
    })
    expectNoStore(response)
  })

  it('has no subscriber reader, pipeline, or email capability', () => {
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('withCron')
    expect(route).not.toContain('sendEmail')
    expect(route).not.toContain(".from('")
    expect(metaMonitor).not.toContain("'weekly-digest'")
    expect(pipelineLogger).not.toContain("'weekly-digest'")
  })
})
