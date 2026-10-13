import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * app/page.tsx is force-dynamic so it never serves an old ranking generation
 * after a publication fence. A CDN `s-maxage` on "/" in vercel.json would let
 * the edge replay stale homepage HTML and silently defeat that intent.
 */
describe('homepage cache headers', () => {
  it('vercel.json does not add a shared-cache Cache-Control header for "/"', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    }
    const homepageCacheHeaders = (config.headers ?? [])
      .filter((rule) => rule.source === '/')
      .flatMap((rule) => rule.headers)
      .filter((header) => header.key.toLowerCase() === 'cache-control')

    expect(homepageCacheHeaders).toEqual([])
  })

  it('app/page.tsx stays request-rendered', () => {
    const source = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf8')
    expect(source).toMatch(/export const dynamic = 'force-dynamic'/)
  })
})
