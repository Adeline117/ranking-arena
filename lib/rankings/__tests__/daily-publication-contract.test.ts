import {
  DAILY_HISTORY_PUBLICATION_CONTRACT,
  acceptPublishedEquity,
} from '../daily-publication-contract'

const point = { date: '2026-08-07', value: 12.5 }
const publication = {
  seasonId: '90D',
  generationId: 'generation-1',
  cohortId: 'cohort-1',
  manifestHash: 'a'.repeat(64),
  expectedCount: 1,
  publishedCount: 1,
  finalizedAt: '2026-08-08T00:00:00.000Z',
}

const published = {
  contract: DAILY_HISTORY_PUBLICATION_CONTRACT,
  available: true,
  publication,
  equity: [point],
  pnl: [point],
  drawdown: [point],
}

describe('daily history publication contract', () => {
  it('rejects legacy positive and quarantined payloads', () => {
    expect(acceptPublishedEquity({ equity: [point], pnl: [point], drawdown: [point] })).toBeNull()
    expect(acceptPublishedEquity({ ...published, available: false })).toBeNull()
  })

  it('rejects available payloads without complete sealed-publication proof', () => {
    expect(acceptPublishedEquity({ ...published, publication: null })).toBeNull()
    expect(
      acceptPublishedEquity({
        ...published,
        publication: { ...publication, publishedCount: 0 },
      })
    ).toBeNull()
    expect(
      acceptPublishedEquity({
        ...published,
        publication: { ...publication, manifestHash: 'not-a-sha256' },
      })
    ).toBeNull()
  })

  it('accepts only a well-formed complete publication', () => {
    expect(acceptPublishedEquity(published)).toEqual(published)
    expect(
      acceptPublishedEquity({ ...published, equity: [{ ...point, value: Number.NaN }] })
    ).toBeNull()
  })
})
