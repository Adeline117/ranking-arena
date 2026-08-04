import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/hashtags/[tag]/route.ts'), 'utf8')
const dataLayer = readFileSync(join(process.cwd(), 'lib/data/hashtags.ts'), 'utf8')
const trendingRoute = readFileSync(
  join(process.cwd(), 'app/api/hashtags/trending/route.ts'),
  'utf8'
)

describe('hashtag post audience boundary', () => {
  it('uses atomic readable RPCs instead of raw service-role table reads', () => {
    expect(dataLayer).toContain("supabase.rpc('get_trending_hashtags_public'")
    expect(dataLayer).toContain("supabase.rpc('get_hashtag_posts_page'")
    expect(dataLayer).not.toContain(".from('hashtags')\n    .select('id, tag, post_count')")
    expect(dataLayer).not.toContain(".from('posts')\n    .select('*')")
    expect(dataLayer).not.toContain('filterServiceReadablePostRows')
  })

  it('binds an optional bearer to the canonical viewer and rejects invalid credentials', () => {
    expect(route).toContain("const authorization = request.headers.get('authorization')")
    expect(route).toContain('authorization === null ? null : await getAuthUser(request)')
    expect(route).toContain('viewer_id: user?.id ?? null')
    expect(route).toContain("response.headers.set('WWW-Authenticate', 'Bearer')")
  })

  it('does not cache either readable hashtag response', () => {
    for (const source of [route, trendingRoute]) {
      expect(source).toContain(
        "response.headers.set('Cache-Control', 'private, no-store, max-age=0')"
      )
      expect(source).toContain("response.headers.set('CDN-Cache-Control', 'no-store')")
      expect(source).toContain("response.headers.set('Vercel-CDN-Cache-Control', 'no-store')")
      expect(source).toContain("varyFields.push('Authorization')")
      expect(source).toContain("export const dynamic = 'force-dynamic'")
    }
    expect(trendingRoute).not.toContain('getServerCache')
    expect(trendingRoute).not.toContain('setServerCache')
  })
})
