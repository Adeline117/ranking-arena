/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  V1_AVATAR_PROXY_NOT_PUBLISHED_CODE,
  V1_AVATAR_PROXY_NO_STORE_HEADERS,
} from '@/lib/security/v1-avatar-proxy-publication'
import { GET } from '../route'

const routeSource = readFileSync(join(process.cwd(), 'app/api/avatar/route.ts'), 'utf8')

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(V1_AVATAR_PROXY_NO_STORE_HEADERS)) {
    expect(response.headers.get(header)).toBe(value)
  }
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}

describe('GET /api/avatar V1 containment', () => {
  it('returns the same fixed no-store 410 for a noisy canonical request', async () => {
    const request = new Request(
      'https://example.com/api/avatar?url=https%3A%2F%2Fqrc.bgstatic.com%2Fotc%2Fimages%2Fa.png&origin=ignored&cache=1'
    )
    const response = (GET as unknown as (input: Request) => Response)(request)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Avatar proxy is temporarily unavailable during V1 verification.',
      code: V1_AVATAR_PROXY_NOT_PUBLISHED_CODE,
    })
    expectNoStore(response)
  })

  it('has no request parameter or acquisition capability', () => {
    const route = codeOnly(routeSource)

    expect(GET).toHaveLength(0)
    expect(route).not.toMatch(/\bNextRequest\b|\bnew\s+URL\b|\bsearchParams\b/)
    expect(route).not.toMatch(/\bdnsLookup\b|\blookup\b|\bfetch\s*\(/)
    expect(route).not.toMatch(/\blogger\b|\bgetCorsOrigin\b|\bBuffer\b|\ballowedDomains\b/)
  })
})
