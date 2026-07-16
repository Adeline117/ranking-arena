import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/search/route.ts'), 'utf8')

describe('search service audience boundary', () => {
  it('caches hot post candidates and authorizes them after every cache hit', () => {
    expect(route).toContain(
      "import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'"
    )
    expect(route).toContain("const CACHE_KEY = 'search:hot:v2:candidates'")
    expect(route).toContain(
      ".select('id, title, hot_score, view_count, like_count, comment_count')"
    )
    expect(route).toMatch(
      /const readableHotPosts = await filterServiceReadablePostRows\(\s*supabase,\s*hotPostCandidates \?\? \[\],\s*null\s*\)/
    )
    expect(route).not.toContain("const CACHE_KEY = 'search:hot:v1'")
  })

  it('does not put derived post keywords in a browser or CDN cache', () => {
    expect(route).toContain("'Cache-Control': 'private, no-store, max-age=0'")
    expect(route).toContain("'CDN-Cache-Control': 'no-store'")
    expect(route).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
  })
})
