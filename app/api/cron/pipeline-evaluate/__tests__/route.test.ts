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

function request(secret?: string): NextRequest {
  return new NextRequest('http://localhost/api/cron/pipeline-evaluate?trace_id=ignored', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/cron/pipeline-evaluate V1 containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'pipeline-evaluate-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it('returns no-store 401 before parsing evaluation hints', async () => {
    const response = GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectNoStore(response)
  })

  it('returns no-store 410 for an authenticated evaluator command', async () => {
    const response = GET(request('pipeline-evaluate-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })
})
