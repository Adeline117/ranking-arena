import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const implementation = readFileSync(join(process.cwd(), 'lib/alerts/run-trader-alerts.ts'), 'utf8')
const runBody = implementation.slice(
  implementation.indexOf('export async function runTraderAlerts')
)

describe('trader alert ranking authority', () => {
  it('reads observations from one sealed public generation', () => {
    expect(implementation).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(implementation).toContain('readSealedRankingGeneration(')
    expect(implementation).toContain("{ season: '90D', sources: ALERT_RANKING_SOURCES }")
    expect(implementation).toContain(".in('source', ALERT_RANKING_SOURCES)")
    expect(implementation).toContain(
      ".filter('rank_publication_id', 'eq', publication.scoreCohortId)"
    )
  })

  it('fails closed before state or delivery writes on observation drift', () => {
    expect(implementation).toContain('if (error || data === null)')
    expect(implementation).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(runBody.indexOf('const sealedObservations = await')).toBeLessThan(
      runBody.indexOf("from('trader_alert_states')")
    )
    expect(runBody.indexOf('const sealedObservations = await')).toBeLessThan(
      runBody.indexOf("from('trader_alert_deliveries')")
    )
  })
})
