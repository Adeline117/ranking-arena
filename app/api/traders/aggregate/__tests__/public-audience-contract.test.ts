import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const aggregateRoute = readFileSync(
  join(process.cwd(), 'app/api/traders/aggregate/route.ts'),
  'utf8'
)
const traderRoute = readFileSync(join(process.cwd(), 'app/api/traders/[handle]/route.ts'), 'utf8')
const linkedData = readFileSync(join(process.cwd(), 'lib/data/linked-traders.ts'), 'utf8')

describe('public linked trader audience boundary', () => {
  it('rechecks active profile state before aggregate cache access', () => {
    expect(aggregateRoute).toContain(
      'const audience = await readPublicProfileAudienceById(supabase, userId)'
    )
    expect(
      aggregateRoute.indexOf('const audience = await readPublicProfileAudienceById')
    ).toBeLessThan(aggregateRoute.indexOf('tieredGetOrSet<AggregatedResponse>'))
    expect(linkedData).toContain(
      'const audience = await readPublicProfileAudienceById(supabase, userId)'
    )
    expect(linkedData).toContain("if (audience.status !== 'active') return null")
  })

  it('never puts owner-linked account payloads in a shared browser or edge cache', () => {
    expect(aggregateRoute).toContain("'Cache-Control': 'private, no-store, max-age=0'")
    expect(aggregateRoute).toContain("'CDN-Cache-Control': 'no-store'")
    expect(aggregateRoute).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
    expect(traderRoute).toContain('const RANKING_NO_STORE_HEADERS =')
    expect(traderRoute).toContain("'CDN-Cache-Control': 'no-store'")
    expect(traderRoute).toContain('return withRankingNoStore(response)')
  })
})
