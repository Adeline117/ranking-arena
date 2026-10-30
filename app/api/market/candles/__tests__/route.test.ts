/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
  V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
} from '@/lib/security/v1-public-egress-publication'
import { GET } from '../route'

const routeSource = readFileSync(join(process.cwd(), 'app/api/market/candles/route.ts'), 'utf8')

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_PUBLIC_EGRESS_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/market/candles V1 containment', () => {
  it('returns the same fixed no-store 410 for a noisy canonical request', async () => {
    const request = new Request(
      'https://example.com/api/market/candles?exchange=binance&symbol=BTC%2FUSDT&timeframe=1m'
    )
    const response = (GET as unknown as (input: Request) => Response)(request)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Public outbound fetch is temporarily unavailable during V1 verification.',
      code: V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('has no request parsing, market-adapter, cache, or outbound acquisition capability', () => {
    const route = codeOnly(routeSource)

    expect(GET).toHaveLength(0)
    for (const forbidden of [
      /\b(?:NextRequest|request|searchParams|new\s+URL)\b/,
      /\bccxt\b/,
      /\bfetch\s*\(/,
      /\b(?:logger|cache|Redis|ioredis)\b/,
      /\b(?:checkRateLimit|RateLimitPresets|Ratelimit)\b/,
      /\b(?:convertTimeframe|TIMEFRAME_SECONDS|UnsupportedExchangeError)\b/,
    ]) {
      expect(route).not.toMatch(forbidden)
    }
  })
})
