import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/hashtags/[tag]/route.ts'), 'utf8')
const dataLayer = readFileSync(join(process.cwd(), 'lib/data/hashtags.ts'), 'utf8')

describe('hashtag post audience boundary', () => {
  it('authorizes service-role post rows for the anonymous viewer', () => {
    expect(dataLayer).toContain(
      "import { filterServiceReadablePostRows } from './service-post-audience'"
    )
    expect(dataLayer).toMatch(
      /const rows = await filterServiceReadablePostRows\(supabase, candidateRows, null\)/
    )
  })

  it('does not CDN-cache the final audience-filtered payload', () => {
    expect(route).toContain("response.headers.set('Cache-Control', 'private, no-store, max-age=0')")
    expect(route).toContain("response.headers.set('CDN-Cache-Control', 'no-store')")
    expect(route).toContain("response.headers.set('Vercel-CDN-Cache-Control', 'no-store')")
  })
})
