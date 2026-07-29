import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/generate-profiles/route.ts'), 'utf8')

describe('generated profile ranking authority', () => {
  it('selects only active, non-quarantined profile sources', () => {
    expect(route).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(route).toContain(".in('platform', PROFILE_RANKING_SOURCES)")
    expect(route).toContain('!isPublicRankingSourceAllowed(profile.platform)')
  })

  it('reads every period from its own sealed generation', () => {
    expect(route).toContain('PROFILE_PERIODS.map((period)')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain('{ season: period, sources: batchSources }')
    expect(route).toContain(".eq('source', source)")
    expect(route).toContain(".in('source_trader_id', [...ids])")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
  })

  it('keeps rank enrichment bound to the composite exchange identity', () => {
    expect(route).toContain('rankIdentity(row.source, row.source_trader_id)')
    expect(route).toContain('rankIdentity(profile.platform, profile.trader_key)')
    expect(route).toContain('!ids.has(row.source_trader_id)')
    expect(route).toContain('proof.published_rank_count')
  })

  it('cannot overwrite a concurrently changed manual or exchange bio', () => {
    expect(route).not.toContain('.upsert(')
    expect(route).toContain('.update({')
    expect(route).toContain("updateQuery.or('bio_source.is.null,bio_source.eq.auto')")
    expect(route).toContain("updateQuery.is('bio_source', null)")
    expect(route).not.toContain('bio.is.null')
    expect(route).toContain("select('trader_key')")
    expect(route).toContain('Profile conditional update failed')
  })
})
