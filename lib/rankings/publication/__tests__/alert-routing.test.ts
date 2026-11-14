import { routeRankPublicationAlert } from '../alert-routing'
import type { RankPublicationAlert } from '../publish-season'

function alert(overrides: Partial<RankPublicationAlert>): RankPublicationAlert {
  return {
    season: '90D',
    severity: 'warning',
    code: 'sources_isolated',
    message: 'm',
    details: {},
    ...overrides,
  }
}

describe('routeRankPublicationAlert', () => {
  it('pages every isolated source under its own season×source cooldown key', () => {
    const routed = routeRankPublicationAlert(alert({ sources: ['bybit', 'okx_futures'] }))
    expect(routed.map((entry) => [entry.sourceSlug, entry.tier, entry.phase])).toEqual([
      ['rank-publication:90D:isolated:bybit', 'A', 0],
      ['rank-publication:90D:isolated:okx_futures', 'A', 0],
    ])
    // A different season of the same source is an independent key.
    expect(
      routeRankPublicationAlert(alert({ season: '7D', sources: ['bybit'] }))[0].sourceSlug
    ).toBe('rank-publication:7D:isolated:bybit')
  })

  it('keeps a season refusal on its own key so isolations cannot suppress it', () => {
    expect(
      routeRankPublicationAlert(alert({ severity: 'critical', code: 'season_publication_refused' }))
    ).toEqual([expect.objectContaining({ sourceSlug: 'rank-publication:90D:refused', tier: 'A' })])
  })

  it('sends exclusion warnings and restorations to the digest only', () => {
    for (const code of ['excluded_rows_over_threshold', 'sources_restored'] as const) {
      expect(routeRankPublicationAlert(alert({ code, sources: ['bybit'] }))).toEqual([
        expect.objectContaining({ sourceSlug: `rank-publication:90D:${code}`, tier: 'B' }),
      ])
    }
  })
})
