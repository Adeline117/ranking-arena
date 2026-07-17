import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/feed/personalized/route.ts'), 'utf8')

describe('personalized feed service audience boundary', () => {
  it('stores only ordered IDs and rehydrates current rows for the exact actor', () => {
    expect(route).toContain(
      "import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'"
    )
    expect(route).toContain('feed:personalized:v3:ids:')
    expect(route).toContain('schema: CandidateIdsSchema')
    expect(route).toContain(".select('id')")
    expect(route).toContain('hydrateCurrentCandidatePosts(supabase, unseenIds, actorId)')
    expect(route).toMatch(
      /const readableRows = await filterServiceReadablePostRows\(\s*supabase,\s*data as CurrentPostRow\[\],\s*actorId\s*\)/
    )
    expect(route).toContain('group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)')
    expect(route).toContain(".from('user_profiles').select('id, handle, avatar_url')")
    expect(route).not.toContain('type PersonalizedFeedCacheEntry')
    expect(route).not.toContain('posts: Record<string, unknown>[]')
  })

  it('does not put the final personalized payload in a browser or CDN cache', () => {
    expect(route).toContain("response.headers.set('Cache-Control', 'private, no-store, max-age=0')")
    expect(route).toContain("response.headers.set('CDN-Cache-Control', 'no-store')")
    expect(route).toContain("response.headers.set('Vercel-CDN-Cache-Control', 'no-store')")
  })
})
