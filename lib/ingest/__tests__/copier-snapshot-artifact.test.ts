import type { SourceRow } from '../core/types'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
} from '../copier-snapshot-artifact'
import { strictCanonicalJson } from '../strict-canonical-json'

const source = {
  id: 34,
  slug: 'gate_futures',
  currency: 'USDT',
  copier_table_depth: 'top10',
  fetch_region: 'local',
  status: 'active',
  serving_mode: 'serving',
} as SourceRow

const firstPage = {
  pageIndex: 1,
  payload: { z: 2, a: [{ id: 'private-upstream-id' }] },
  url: 'https://example.test/copiers?page=1',
  fetchedAt: '2026-08-04T10:00:00.000Z',
}
const secondPage = {
  pageIndex: 2,
  payload: { rows: [] },
  url: 'https://example.test/copiers?page=2',
  fetchedAt: '2026-08-04T10:00:01.000Z',
}

function build(overrides: Partial<Parameters<typeof buildCopierSnapshotArtifact>[0]> = {}) {
  return buildCopierSnapshotArtifact({
    src: source,
    traderId: 101,
    exchangeTraderId: 'trader-101',
    lane: 'tier_c',
    requestTimeframe: 0,
    pages: [firstPage, secondPage],
    callerLimited: true,
    ...overrides,
  })
}

describe('copier snapshot acquisition artifact', () => {
  it('binds the complete capture shape to one immutable canonical artifact', () => {
    const artifact = build()

    expect(artifact).toEqual({
      contract: COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
      source: {
        id: 34,
        slug: 'gate_futures',
        currency: 'USDT',
        copier_table_depth: 'top10',
        fetch_region: 'local',
      },
      trader: { id: 101, exchange_trader_id: 'trader-101' },
      lane: 'tier_c',
      request_timeframe: 0,
      observed_at: secondPage.fetchedAt,
      page_count: 2,
      scan_terminal_state: 'caller_limited',
      caller_limited: true,
      source_reported_row_count: null,
      pages: [firstPage, secondPage],
    })
    expect(copierSnapshotSourceRunId(artifact)).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.pages[0].payload)).toBe(true)
  })

  it('is stable across input key order and changes for a new observation', () => {
    const left = build()
    const reorderedPayload = {
      ...firstPage,
      payload: { a: [{ id: 'private-upstream-id' }], z: 2 },
    }
    const right = build({ pages: [reorderedPayload, secondPage] })
    expect(strictCanonicalJson(left)).toBe(strictCanonicalJson(right))
    expect(copierSnapshotSourceRunId(left)).toBe(copierSnapshotSourceRunId(right))

    const later = build({
      pages: [firstPage, { ...secondPage, fetchedAt: '2026-08-04T10:00:02.000Z' }],
    })
    expect(copierSnapshotSourceRunId(later)).not.toBe(copierSnapshotSourceRunId(left))
  })

  it('keeps Tier-B timeframe-independent and explicitly unverified', () => {
    const artifact = build({
      lane: 'tier_b',
      requestTimeframe: null,
      pages: [firstPage],
      callerLimited: false,
    })
    expect(artifact).toMatchObject({
      lane: 'tier_b',
      request_timeframe: null,
      observed_at: firstPage.fetchedAt,
      page_count: 1,
      scan_terminal_state: 'stream_exhausted_unverified',
      caller_limited: false,
      source_reported_row_count: null,
    })
  })

  it.each([
    ['zero pages', { pages: [] }],
    ['non-serving source', { src: { ...source, serving_mode: 'shadow' } as SourceRow }],
    ['missing copier surface', { src: { ...source, copier_table_depth: 'none' } as SourceRow }],
    ['Tier-B caller cap', { lane: 'tier_b', requestTimeframe: null, callerLimited: true }],
    ['Tier-B timeframe', { lane: 'tier_b', requestTimeframe: 30, callerLimited: false }],
    [
      'decreasing clocks',
      {
        pages: [{ ...firstPage, fetchedAt: '2026-08-04T10:00:02.000Z' }, secondPage],
      },
    ],
    ['noncanonical clock', { pages: [{ ...firstPage, fetchedAt: '2026-08-04 10:00:00Z' }] }],
    ['noncanonical payload', { pages: [{ ...firstPage, payload: { unsafe: undefined } }] }],
  ])('rejects %s before a RAW write', (_label, overrides) => {
    expect(() => build(overrides as never)).toThrow('[ingest] copier snapshot artifact failed:')
  })
})
