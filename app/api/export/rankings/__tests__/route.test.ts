/** @jest-environment node */

import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import {
  V1_RANKINGS_EXPORT_NO_STORE_HEADERS,
  V1_RANKINGS_EXPORT_UNAVAILABLE_BODY,
} from '@/lib/rankings/v1-rankings-export-publication'
import { GET } from '../route'

const routeSource = readFileSync(join(process.cwd(), 'app/api/export/rankings/route.ts'), 'utf8')

function request(secret?: string): NextRequest {
  return new NextRequest(
    'https://example.com/api/export/rankings?format=json&exchange=ignored&limit=2000',
    { headers: secret ? { authorization: `Bearer ${secret}` } : undefined }
  )
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_RANKINGS_EXPORT_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/export/rankings V1 containment', () => {
  const originalCronSecret = process.env.CRON_SECRET
  const originalCrypto = globalThis.crypto

  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  })

  beforeEach(() => {
    process.env.CRON_SECRET = 'rankings-export-v1-test-secret'
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
    const response = await GET(request('rankings-export-v1-test-secret'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(V1_RANKINGS_EXPORT_UNAVAILABLE_BODY)
    expectNoStore(response)
  })

  it('keeps rate-limit, query, Supabase, CSV, and logger work out of the route', () => {
    const route = codeOnly(routeSource)

    expect(route).toContain('verifyEdgeCronSecret(request)')
    for (const forbidden of [
      /checkRateLimit|RateLimitPresets/,
      /request\.url|new\s+URL|searchParams/,
      /getSupabaseAdmin|SupabaseClient|leaderboard_ranks|\.from\(/,
      /escapeCsv|Content-Disposition|text\/csv|application\/json/,
      /\blogger\b|\.select\(|\.limit\(/,
    ]) {
      expect(route).not.toMatch(forbidden)
    }
  })
})
