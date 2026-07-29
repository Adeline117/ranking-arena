import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/notifications/ranking-changes/route.ts'),
  'utf8'
)

describe('ranking change notification authority', () => {
  it('reads current ranks from one sealed public generation', () => {
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain("{ season: '90D', sources: uniqueSources }")
    expect(route).toContain(".in('source', uniqueSources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(route).toContain('filterPublicRankingSources(watchedSources)')
  })

  it('rejects malformed or non-public watch identities', () => {
    expect(route).toContain('!isPublicRankingSourceAllowed(t.source)')
    expect(route).toContain('t.source_trader_id !== t.source_trader_id.trim()')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
  })

  it('fails closed on every mutable read and notification write', () => {
    expect(route).toContain('if (prefsError || prefs === null)')
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('if (prevRanksError || prevRanks === null)')
    expect(route).toContain('if (traderInfosError || traderInfos === null)')
    expect(route).toContain('Ranking notification batch insert failed:')
  })

  it('compares against the exact previous-day snapshot', () => {
    expect(route).toContain(".eq('snapshot_date', yesterday)")
    expect(route).not.toContain(".gte('snapshot_date', yesterday)")
  })
})
