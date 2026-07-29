import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/aggregate-daily-snapshots/route.ts'),
  'utf8'
)

describe('daily snapshot ranking authority', () => {
  it('uses one sealed public cohort for rank gap fill and fallback', () => {
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route.match(/rank_publication_id/g)).toHaveLength(2)
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
  })

  it('makes every finite rank read deterministic', () => {
    expect(route.match(/\.order\('rank', \{ ascending: true \}\)/g)).toHaveLength(2)
    expect(route.match(/\.order\('source_trader_id', \{ ascending: true \}\)/g)).toHaveLength(2)
    expect(route).toContain('.limit(PER_PLATFORM_FALLBACK_LIMIT)')
    expect(route).toContain('.limit(GAP_FILL_LIMIT)')
  })

  it('fails closed on missing reads and partial writes', () => {
    expect(route).toContain('data === null')
    expect(route).toContain('prevSnapshots === null')
    expect(route).toContain('No authoritative public snapshot rows available')
    expect(route).toContain('if (errors > 0)')
    expect(route).toContain('snapshot writes failed')
    expect(route).toContain('current ranks cannot backfill past dates')
    expect(route).toContain('if (!isLatestSnapshotDate) return []')
  })

  it('filters historical RPC rows before they can be persisted', () => {
    expect(route).toContain('!isPublicRankingSourceAllowed(s.source)')
    expect(route.indexOf('isPublicRankingSourceAllowed(s.source)')).toBeLessThan(
      route.indexOf(".from('trader_daily_snapshots')")
    )
  })
})
