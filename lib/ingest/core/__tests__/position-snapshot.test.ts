import {
  assertPositionPublicationEvidence,
  assertPositionSnapshotEvidence,
  type PositionSnapshotEvidence,
} from '../position-snapshot'
import type { RawBundle } from '../types'

function bundle(payload: unknown, pageIndex = 1): RawBundle {
  const fetchedAt = '2026-07-29T12:00:00.000Z'
  return {
    fetchedAt,
    pages: [{ pageIndex, payload, url: 'https://exchange.test/positions', fetchedAt }],
  }
}

describe('position snapshot evidence', () => {
  it.each([
    { code: 0, data: [] },
    { code: '0', data: [] },
    { code: 200, data: [] },
    { code: '200', data: [] },
    { code: '00000', data: [] },
    { code: '000000', data: [] },
    { retCode: 0, result: { data: [] } },
    { errno: 'OK', success: true, data: { list: [] } },
    { assetPositions: [], marginSummary: {} },
  ])('accepts a non-empty successful response envelope', (payload) => {
    expect(() => assertPositionSnapshotEvidence(bundle(payload), 'source/trader')).not.toThrow()
  })

  it.each([
    null,
    [],
    {},
    { success: false, data: [] },
    { code: 500, data: null },
    { code: '30066', data: null },
    { retCode: 10001, result: null },
    { errno: 'Forbidden', success: false },
  ])('rejects absent, malformed, or explicit failure envelopes', (payload) => {
    expect(() => assertPositionSnapshotEvidence(bundle(payload), 'source/trader')).toThrow()
  })

  it('rejects missing and duplicate page evidence', () => {
    expect(() =>
      assertPositionSnapshotEvidence(
        { pages: [], fetchedAt: '2026-07-29T12:00:00.000Z' },
        'source/trader'
      )
    ).toThrow('no captured source page')

    const repeated = bundle({ code: 200, data: [] })
    repeated.pages.push({ ...repeated.pages[0] })
    expect(() => assertPositionSnapshotEvidence(repeated, 'source/trader')).toThrow(
      'invalid source page identity'
    )
  })

  it('issues an unforgeable publication capability only after validation', () => {
    const evidence = assertPositionSnapshotEvidence(
      bundle({ code: 200, data: [] }),
      'source/trader'
    )
    expect(() => assertPositionPublicationEvidence(evidence)).not.toThrow()
    expect(() =>
      assertPositionPublicationEvidence({
        context: 'source/trader',
        pageCount: 1,
      } as PositionSnapshotEvidence)
    ).toThrow('lacks validated source evidence')
  })
})
