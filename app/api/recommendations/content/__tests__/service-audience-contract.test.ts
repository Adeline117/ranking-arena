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
})
