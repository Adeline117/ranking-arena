import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/feed/personalized/route.ts'), 'utf8')

describe('personalized feed service audience boundary', () => {
  it('treats cached rows as candidates and authorizes them for the exact actor', () => {
    expect(route).toContain(
      "import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'"
    )
    expect(route).toContain('feed:personalized:v2:candidates:')
    expect(route).not.toContain('`feed:personalized:${userId}')
    expect(route).toMatch(
      /const readablePosts = await filterServiceReadablePostRows\(\s*getSupabaseAdmin\(\),\s*postCandidates,\s*user\?\.id \?\? null\s*\)/
    )
    expect(route).toMatch(/successWithPagination\(\s*\{ posts: readablePosts \}/)
  })

  it('does not put the final personalized payload in a browser or CDN cache', () => {
    expect(route).toContain("response.headers.set('Cache-Control', 'private, no-store, max-age=0')")
    expect(route).toContain("response.headers.set('CDN-Cache-Control', 'no-store')")
    expect(route).toContain("response.headers.set('Vercel-CDN-Cache-Control', 'no-store')")
  })
})
