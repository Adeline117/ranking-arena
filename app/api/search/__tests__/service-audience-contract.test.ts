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

  it('re-authorizes unified post results and post-title suggestions on cache hits', () => {
    expect(route).toContain('search:unified:v3:candidates:')
    expect(route).toMatch(/const cached = await cacheGet<UnifiedSearchCacheCandidate>\(cacheKey\)/)
    expect(route).toMatch(
      /const result = await materializeUnifiedSearchCandidate\(supabase, cached\)/
    )
    expect(route).toContain(".select('id, title')")
    expect(route).toMatch(
      /const readablePostSuggestions = await filterServiceReadablePostRows\(\s*supabase,\s*hotPostSuggestions,\s*null\s*\)/
    )
    expect(route).not.toContain('search:unified:v2:')
  })

  it('rematerializes current discoverable groups and rechecks public profiles after cache hits', () => {
    expect(route.match(/\.is\('dissolved_at', null\)/g)).toHaveLength(3)
    expect(route.match(/\.in\('visibility'/g)).toHaveLength(3)
    expect(route).toContain(".from('public_user_profiles')")
    expect(route).toContain('readCurrentSearchGroups(supabase, groupIds)')
    expect(route).toContain(".select('id, name, description, member_count')")
    expect(route).toContain('const group = currentGroups.get(candidateGroup.id)')
    expect(route).toContain('title: group.name')
    expect(route).toContain('subtitle: group.description || undefined')
    expect(route).toContain('meta: { member_count: group.member_count }')
    expect(route).toContain('.map((group) => currentGroups.get(group.id)?.name)')
    expect(route).toContain('readCurrentSearchUserIds(supabase, userIds)')
  })
})
