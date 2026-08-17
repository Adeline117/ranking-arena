/**
 * @jest-environment node
 */

import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import {
  GET,
  LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED,
  LEGACY_PROXY_ACQUISITION_NO_STORE_HEADERS,
} from '../route'

const root = process.cwd()
const route = readFileSync(join(root, 'app/api/proxy/phemex/route.ts'), 'utf8')

function request(secret?: string): NextRequest {
  return new NextRequest(
    'https://example.com/api/proxy/phemex?page=999&pageSize=999&sortBy=ignored&period=ignored',
    { headers: secret ? { authorization: `Bearer ${secret}` } : undefined }
  )
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(LEGACY_PROXY_ACQUISITION_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/proxy/phemex V1 containment', () => {
  const originalCronSecret = process.env.CRON_SECRET
  const originalCrypto = globalThis.crypto

  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  })

  beforeEach(() => {
    process.env.CRON_SECRET = 'phemex-proxy-v1-test-secret'
  })

  afterAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true })
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  })

  it.each([undefined, 'wrong-secret'])(
    'returns no-store 401 before disclosing the hold for an absent or invalid secret',
    async (secret) => {
      const response = await GET(request(secret))

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )

  it('returns a fixed no-store 410 for a valid secret without using supplied parameters', async () => {
    const response = await GET(request('phemex-proxy-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED,
      message: 'Legacy proxy acquisition is temporarily unavailable during V1 verification.',
    })
    expectNoStore(response)
  })

  it('keeps all URL, acquisition, logging, and provider work out of the route', () => {
    expect(route).toContain('verifyEdgeCronSecret')
    expect(route).not.toContain('new URL')
    expect(route).not.toContain('searchParams')
    expect(route).not.toContain('fetch(')
    expect(route).not.toContain('createLogger')
    expect(route).not.toContain('targetUrl')
    expect(route).not.toContain('api.phemex.com')
  })
})
