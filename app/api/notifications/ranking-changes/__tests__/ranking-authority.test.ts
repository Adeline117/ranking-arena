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

  it('fails closed on every mutable read and delegates notification writes', () => {
    expect(route).toContain('if (prefsError || prefs === null)')
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('if (prevRanksError || prevRanks === null)')
    expect(route).toContain('if (traderInfosError || traderInfos === null)')
    expect(route).toContain('await createRankingNotificationsBatch(supabase, notificationRows)')
    expect(route).not.toContain('from(NOTIF_TABLE).insert')
    expect(route).not.toContain("from('notifications').insert")
  })

  it('compares against the exact previous-day snapshot', () => {
    expect(route).toContain(".eq('snapshot_date', yesterday)")
    expect(route).not.toContain(".gte('snapshot_date', yesterday)")
  })

  it('binds every retry identity to source, trader, comparison date, and ranks', () => {
    expect(route).toContain('watchedRankingChangeReference(')
    expect(route).toContain('yesterday,')
    expect(route).toContain('prevRank,')
    expect(route).toContain('current.rank')
    expect(route).toContain('watchedRankingChangeLink(sourceId, source)')
  })
})
