import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/hashtags/[tag]/route.ts'), 'utf8')
const dataLayer = readFileSync(join(process.cwd(), 'lib/data/hashtags.ts'), 'utf8')

describe('hashtag post audience boundary', () => {
  it('authorizes service-role post rows for the resolved viewer before pagination', () => {
    expect(dataLayer).toContain(
      "import { filterServiceReadablePostRowsStrict } from './service-post-audience'"
    )
    expect(dataLayer).toMatch(
      /filterServiceReadablePostRowsStrict\(\s*supabase,\s*candidateRows,\s*viewer_id\s*\)/
    )
    expect(dataLayer.indexOf('filterServiceReadablePostRowsStrict')).toBeLessThan(
      dataLayer.indexOf('readableRows.slice(offset, offset + limit)')
    )
  })

  it('marks success, error, and rate-limit responses as auth-sensitive', () => {
    expect(route).toContain("response.headers.set('Cache-Control', 'private, no-store, max-age=0')")
    expect(route).toContain("response.headers.set('CDN-Cache-Control', 'no-store')")
    expect(route).toContain("response.headers.set('Vercel-CDN-Cache-Control', 'no-store')")
    expect(route).toContain("vary.add('Authorization')")
    expect(route).toMatch(/rateLimitResponse\) return privateNoStore\(rateLimitResponse\)/)
    expect(route).toMatch(/privateNoStore\(handleError\(error, 'hashtags \[tag\] GET'\)\)/)
  })

  it('never publishes a raw service-role count as viewer total', () => {
    expect(dataLayer).not.toContain("count: 'exact'")
    expect(dataLayer).toContain('const total = sourceExhausted ? readableRows.length : null')
  })
})
