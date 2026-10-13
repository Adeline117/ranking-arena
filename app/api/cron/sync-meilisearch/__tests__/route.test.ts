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

import { NextRequest } from 'next/server'
import {
  V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
  V1_CRON_EXECUTION_NO_STORE_HEADERS,
} from '@/lib/cron/v1-execution-publication'
import { GET } from '../route'

const originalCronSecret = process.env.CRON_SECRET

function createRequest(secret?: string): NextRequest {
  const headers = secret ? { authorization: `Bearer ${secret}` } : undefined
  return new NextRequest('http://localhost/api/cron/sync-meilisearch?full=1', { headers })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/cron/sync-meilisearch V1 containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'sync-meilisearch-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it('returns no-store 401 before interpreting command parameters', async () => {
    const response = GET(createRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectNoStore(response)
  })

  it('returns no-store 410 for an authenticated direct command without contacting Meilisearch', async () => {
    const response = GET(createRequest('sync-meilisearch-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })
})
