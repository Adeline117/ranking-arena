import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const implementation = readFileSync(join(process.cwd(), 'lib/alerts/run-trader-alerts.ts'), 'utf8')
const runBody = implementation.slice(
  implementation.indexOf('export async function runTraderAlerts')
)

describe('trader alert ranking authority', () => {
  it('reads observations from one sealed public generation', () => {
    expect(implementation).toContain('readSealedRankingAuthorityGeneration(')
    expect(implementation).toContain('const authoritySources = publication.proofs.map')
    expect(implementation).toContain(".in('source', authoritySources)")
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
