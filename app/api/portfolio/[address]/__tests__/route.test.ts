/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
  V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
} from '@/lib/security/v1-public-egress-publication'
import { GET } from '../route'

const routeSource = readFileSync(
  join(process.cwd(), 'app/api/portfolio/[address]/route.ts'),
  'utf8'
)

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_PUBLIC_EGRESS_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('GET /api/portfolio/[address] V1 containment', () => {
  it('returns the same fixed no-store 410 for ignored path and request values', async () => {
    const request = new Request(
      'https://example.com/api/portfolio/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?include=nfts&cache=1'
    )
    const response = (
      GET as unknown as (
        input: Request,
        context: { params: Promise<{ address: string }> }
      ) => Response
    )(request, {
      params: Promise.resolve({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    })

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Public outbound fetch is temporarily unavailable during V1 verification.',
      code: V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('keeps the default runtime and forces dynamic handling', () => {
    const route = codeOnly(routeSource)

    expect(route).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(route).not.toMatch(/export const runtime/)
  })

  it('has no path input, public wrapper, cache, EVM adapter, logger, or RPC capability', () => {
    const route = codeOnly(routeSource)

    expect(GET).toHaveLength(0)
    for (const forbidden of [
      /\b(?:NextRequest|request|params|searchParams|new\s+URL|address)\b/,
      /\b(?:withPublic|isValidEvmAddress|extractAddress)\b/,
      /\bfetch\s*\(/,
      /\b(?:logger|createLogger|cache|Redis|ioredis)\b/,
      /\b(?:getPortfolio|evm-adapter|EVM|ethers|viem|rpc)\b/i,
      /\b(?:checkRateLimit|RateLimitPresets|Ratelimit)\b/,
    ]) {
      expect(route).not.toMatch(forbidden)
    }
  })
})
