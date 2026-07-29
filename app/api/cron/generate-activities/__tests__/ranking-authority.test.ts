import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/generate-activities/route.ts'), 'utf8')

describe('generated activity ranking authority', () => {
  it('materializes activities from one sealed public generation', () => {
    expect(route).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain("{ season: '90D', sources: ACTIVITY_RANKING_SOURCES }")
    expect(route).toContain(".in('source', ACTIVITY_RANKING_SOURCES)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on query or source-boundary drift before the activity upsert', () => {
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(route.indexOf('const sealedRead = await')).toBeLessThan(
      route.indexOf(".from('trader_activities')")
    )
  })

  it('uses deterministic finite ordering and labels the global rank honestly', () => {
    expect(route).toContain(".order('arena_score', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('ranked #${t.rank} across Arena')
    expect(route).not.toContain('ranked #${t.rank} on ${ex}')
  })
})
