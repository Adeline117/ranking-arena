/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
  V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
} from '@/lib/security/v1-public-egress-publication'
import { GET } from '../route'

const routeSource = readFileSync(join(process.cwd(), 'app/api/market/arbitrage/route.ts'), 'utf8')

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_PUBLIC_EGRESS_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/market/arbitrage V1 containment', () => {
  it('returns the same fixed no-store 410 for a noisy canonical request', async () => {
    const request = new Request(
      'https://example.com/api/market/arbitrage?symbols=BTC%2FUSDT&exchanges=binance,okx&cache=1'
    )
    const response = (GET as unknown as (input: Request) => Response)(request)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Public outbound fetch is temporarily unavailable during V1 verification.',
      code: V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('retains the dynamic route metadata', () => {
    expect(codeOnly(routeSource)).toMatch(/export const dynamic = 'force-dynamic'/)
  })

  it('has no request, cache, rate-limit, or exchange acquisition capability', () => {
    const route = codeOnly(routeSource)

    expect(GET).toHaveLength(0)
    for (const forbidden of [
      /\b(?:NextRequest|request|searchParams|new\s+URL)\b/,
      /\bfetch\s*\(/,
      /\bccxt\b/,
      /\b(?:logger|cache|Redis|ioredis)\b/,
      /\b(?:getOrSetWithLock|detectArbitrageOpportunities)\b/,
      /\b(?:checkRateLimit|RateLimitPresets|Ratelimit)\b/,
    ]) {
      expect(route).not.toMatch(forbidden)
    }
  })
})
