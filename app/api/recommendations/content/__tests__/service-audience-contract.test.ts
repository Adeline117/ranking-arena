import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/recommendations/content/route.ts'), 'utf8')

describe('content recommendation service audience boundary', () => {
  it('never attaches or returns service-role post rows before canonical authorization', () => {
    expect(route).toContain(
      "import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'"
    )
    expect(route).toMatch(
      /const readablePosts = await filterServiceReadablePostRows\(supabase, postCandidates, actorId\)/
    )
    expect(route).not.toMatch(/async function attachAuthors\(/)
    expect(route.match(/authorizePostsAndAttachAuthors\(/g)).toHaveLength(4)
  })

  it('uses the anonymous actor and a fresh cache namespace for public recommendations', () => {
    expect(route).toContain('rec:content:v2:candidates:anon:')
    expect(route).not.toContain('`rec:content:anon:')
    expect(route).toMatch(
      /const recommendations = await authorizePostsAndAttachAuthors\(supabase, candidates, null\)/
    )
    expect(route).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
  })

  it('binds authenticated fallback and personalized reads to the canonical user', () => {
    const actorBoundCalls = route.match(/authorizePostsAndAttachAuthors\([\s\S]*?user\.id\s*\)/g)
    expect(actorBoundCalls).toHaveLength(2)
  })

  it('routes group recommendations through a fresh discoverability boundary', () => {
    expect(route).toContain("if (contentType === 'group')")
    expect(route).toContain('getCurrentGroupRecommendations(supabase, user?.id ?? null, limit)')
    expect(route).toContain(".rpc('recommend_groups_for_user'")
    expect(route.match(/\.is\('dissolved_at', null\)/g)).toHaveLength(2)
    expect(route.match(/\.in\('visibility'/g)).toHaveLength(2)
    expect(route).toContain("const DISCOVERABLE_GROUP_VISIBILITIES = ['open', 'apply']")

    const groupBranch = route.indexOf("if (contentType === 'group')")
    const anonymousPostCache = route.indexOf('rec:content:v2:candidates:anon:')
    expect(groupBranch).toBeGreaterThan(-1)
    expect(groupBranch).toBeLessThan(anonymousPostCache)
  })

  it('uses the generated collaborative RPC contract and never caches final responses', () => {
    expect(route).toContain('p_target_type: contentType')
    expect(route).toContain('row.target_id')
    expect(route).not.toContain('p_type: contentType')
    expect(route).not.toContain('row.item_id')
    expect(route.match(/NO_STORE_HEADERS/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
  })

  it('materializes trader recommendations by current composite identity', () => {
    expect(route).toContain("if (contentType === 'trader')")
    expect(route).toContain('getCurrentTraderRecommendations(supabase, user?.id ?? null, limit)')
    expect(route).toContain("p_target_type: 'trader'")
    expect(route).toContain(".from('leaderboard_ranks')")
    expect(route).toContain(".in('source_trader_id', traderKeys)")
    expect(route).toContain('currentByIdentity.get(candidate.targetId)')
    expect(route).not.toContain('// For other types, return raw RPC data')

    const traderBranch = route.indexOf("if (contentType === 'trader')")
    const anonymousPostCache = route.indexOf('rec:content:v2:candidates:anon:')
    expect(traderBranch).toBeGreaterThan(-1)
    expect(traderBranch).toBeLessThan(anonymousPostCache)
  })
})
