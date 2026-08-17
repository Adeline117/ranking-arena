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
import { GET, POST } from '../route'

const originalCronSecret = process.env.CRON_SECRET

function request(method: 'GET' | 'POST', secret?: string): NextRequest {
  return new NextRequest('http://localhost/api/hooks/post-deploy?deploy_id=ignored', {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('retired post-deploy evaluator hook', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'post-deploy-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)('returns no-store 401 for an unauthenticated %s request', async (method, handler) => {
    const response = handler(request(method))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectNoStore(response)
  })

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)('returns no-store 410 for an authenticated %s request', async (method, handler) => {
    const response = handler(request(method, 'post-deploy-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })
})
