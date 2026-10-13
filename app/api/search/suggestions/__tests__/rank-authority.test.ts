import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/search/suggestions/route.ts'), 'utf8')

describe('search suggestions ranking authority', () => {
  it('uses the shared live public-cohort reader and never caches metric-bearing suggestions', () => {
    expect(route).toContain("import { searchTraders } from '@/lib/data/unified'")
    expect(route).toContain(
      'const unifiedTraders = await searchTraders(supabase, { query, limit })'
    )
    expect(route).not.toContain("from '@/lib/cache'")
    expect(route).not.toContain('cacheKey')
    expect(route).toContain("'Cache-Control': 'private, no-store, max-age=0'")
    expect(route).toContain("'CDN-Cache-Control': 'no-store'")
    expect(route).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
    expect(route).toContain(
      'return success({ suggestions: [] }, 200, SEARCH_SUGGESTIONS_NO_STORE_HEADERS)'
    )
    expect(route).not.toContain('s-maxage=60')
  })
})
