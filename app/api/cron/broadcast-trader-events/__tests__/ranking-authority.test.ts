import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/broadcast-trader-events/route.ts'),
  'utf8'
)

describe('broadcast ranking notification authority', () => {
  it('reads current ranks from one sealed public generation', () => {
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on a source-boundary breach before notification fan-out', () => {
    expect(route).toContain('lr.some((row) => !isPublicRankingSourceAllowed(row.source))')
    expect(route).toContain(
      "throw new Error('broadcast ranking query crossed the public source boundary')"
    )
    expect(route.indexOf('const sealedEventRows = await')).toBeLessThan(
      route.indexOf("type: 'ranking_change'")
    )
  })

  it('paginates the sealed cohort in deterministic composite order', () => {
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
  })

  it('uses the retry-safe batch authority and pushes only newly created rows', () => {
    expect(route).toContain('await createRankingNotificationsBatch(supabase, rows)')
    expect(route).toContain('delivery.created.slice(')
    expect(route).not.toContain("from('notifications').insert")
    expect(route).toContain('traderEventReference(traderId, source, kind, yStr)')
  })

  it('does not consume new-position state before durable notification creation', () => {
    expect(route).toContain('pendingPositionSeenRows.push(...seenRows)')
    expect(route).toContain('await persistPendingPositionSeen()')
    expect(route.indexOf('const delivery = await createRankingNotificationsBatch')).toBeLessThan(
      route.lastIndexOf('await persistPendingPositionSeen()')
    )
  })
})
