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

function requestWithSecret(secret?: string): NextRequest {
  return new NextRequest(
    'http://localhost/api/cron/backfill-avatars?platform=%3Cignored%3E&limit=-999&mode=legacy',
    { headers: secret ? { authorization: `Bearer ${secret}` } : undefined }
  )
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_CRON_EXECUTION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/cron/backfill-avatars V1 containment', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'backfill-avatars-v1-test-secret'
  })

  afterAll(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([undefined, 'not-the-backfill-avatars-secret'])(
    'returns no-store 401 before handling noisy parameters for secret %s',
    async (secret) => {
      const response = GET(requestWithSecret(secret))

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )

  it('returns no-store 410 for an authenticated avatar-backfill command', async () => {
    const response = GET(requestWithSecret('backfill-avatars-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })
})
