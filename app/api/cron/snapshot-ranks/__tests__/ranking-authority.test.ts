import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/snapshot-ranks/route.ts'), 'utf8')

describe('rank history snapshot authority', () => {
  it('reads every period from one sealed public generation', () => {
    expect(route).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain('{ season: period, sources: SNAPSHOT_RANKING_SOURCES }')
    expect(route).toContain(".in('source', SNAPSHOT_RANKING_SOURCES)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
  })

  it('uses a deterministic top-N order before persisting history', () => {
    expect(route).toContain(".order('rank', { ascending: true })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route.indexOf('const rows = sealedRows.value')).toBeLessThan(
      route.indexOf(".from('rank_history')")
    )
  })

  it('fails closed on rank reads, writes, and cleanup errors', () => {
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('publishedCount > 0 && data.length === 0')
    expect(route).toContain('Rank history upsert failed')
    expect(route).toContain('Rank history cleanup failed')
  })
})
