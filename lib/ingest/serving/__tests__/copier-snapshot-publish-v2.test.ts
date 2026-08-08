const mockPoolQuery = jest.fn()
const mockIngestClientConnect = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: (...args: unknown[]) => mockIngestClientConnect(...args),
}))

import type { ParsedCopierRow } from '../../core/types'
import {
  COPIER_SNAPSHOT_PUBLICATION_V2_CONTRACT,
  publishCopierSnapshotV2,
  type PublishCopierSnapshotV2Input,
} from '../publish'

const SOURCE_RUN_ID = 'a'.repeat(64)
const ACQUISITION_SOURCE_RUN_ID = 'b'.repeat(64)
const OBSERVED_AT = '2026-08-04T10:00:00.000Z'
const PUBLISHED_AT = '2026-08-04T10:00:01.000Z'

const copierRow: ParsedCopierRow = {
  kind: 'copiers',
  ts: '2026-08-04T09:59:00.000Z',
  copierLabel: 'private-copier',
  copierPnl: -2.5,
  copierInvested: 100,
  copyDurationDays: 7,
  dedupeHash: 'copier-1',
  raw: { privateId: 'private-copier', nested: { exact: true } },
}

function input(
  overrides: Partial<PublishCopierSnapshotV2Input> = {}
): PublishCopierSnapshotV2Input {
  return {
    lane: 'tier_b',
    sourceId: 34,
    traderId: 42,
    rawObject: {
      id: 2_081_897,
      storagePath:
        `binance_futures/copier_publication/tier_b/${SOURCE_RUN_ID}/` +
        `copier_snapshot_${SOURCE_RUN_ID}.json.gz`,
      contentHash: SOURCE_RUN_ID,
    },
    sourceRunId: SOURCE_RUN_ID,
    acquisitionSourceRunId: ACQUISITION_SOURCE_RUN_ID,
    observedAt: OBSERVED_AT,
    currency: 'USDC',
    evidenceState: 'verified',
    scanTerminalState: 'exhausted',
    blockerReasons: [],
    rows: [copierRow],
    ...overrides,
  }
}

function receipt(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    receiptId: 501,
    lane: 'tier_b',
    sourceRunId: SOURCE_RUN_ID,
    acquisitionSourceRunId: ACQUISITION_SOURCE_RUN_ID,
    observedAt: OBSERVED_AT,
    publishedAt: PUBLISHED_AT,
    rowCount: 1,
    ...overrides,
  }
}

function rpcResult(value: unknown = receipt()): Record<string, unknown> {
  return {
    command: 'SELECT',
    rowCount: 1,
    rows: [{ receipt: value }],
  }
}

describe('lane-bound copier snapshot V2 publication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPoolQuery.mockResolvedValue(rpcResult())
  })

  it('sends the exact lane and dual-digest request through only the V2 owner RPC', async () => {
    await expect(publishCopierSnapshotV2(input())).resolves.toEqual(receipt())

    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    expect(String(mockPoolQuery.mock.calls[0][0])).toBe(
      'SELECT public.publish_copier_snapshot_v2($1::jsonb) AS receipt'
    )
    const payload = JSON.parse(String(mockPoolQuery.mock.calls[0][1][0]))
    expect(Object.keys(payload).sort()).toEqual(
      [
        'acquisitionSourceRunId',
        'blockerReasons',
        'contract',
        'currency',
        'evidenceState',
        'lane',
        'observedAt',
        'rawObjectId',
        'rows',
        'scanTerminalState',
        'sourceId',
        'sourceRunId',
        'traderId',
      ].sort()
    )
    expect(payload).toMatchObject({
      acquisitionSourceRunId: ACQUISITION_SOURCE_RUN_ID,
      blockerReasons: [],
      contract: COPIER_SNAPSHOT_PUBLICATION_V2_CONTRACT,
      currency: 'USDC',
      evidenceState: 'verified',
      lane: 'tier_b',
      observedAt: OBSERVED_AT,
      rawObjectId: 2_081_897,
      scanTerminalState: 'exhausted',
      sourceId: 34,
      sourceRunId: SOURCE_RUN_ID,
      traderId: 42,
    })
    expect(payload.rows).toEqual([
      {
        ts: copierRow.ts,
        copierLabel: copierRow.copierLabel,
        copierPnl: copierRow.copierPnl,
        copierInvested: copierRow.copierInvested,
        copyDurationDays: copierRow.copyDurationDays,
        dedupeHash: copierRow.dedupeHash,
        raw: copierRow.raw,
      },
    ])
    expect(mockIngestClientConnect).not.toHaveBeenCalled()
    expect(String(mockPoolQuery.mock.calls[0][0])).not.toMatch(
      /copier_snapshot_publications|copier_snapshot_rows|copier_records/i
    )
  })

  it('accepts an exact replay receipt without rebasing either digest or lane', async () => {
    await expect(publishCopierSnapshotV2(input())).resolves.toEqual(receipt())
    await expect(publishCopierSnapshotV2(input())).resolves.toEqual(receipt())

    expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(mockPoolQuery.mock.calls[1][1])
  })

  it('supports a verified zero-row receipt without manufacturing a private row', async () => {
    mockPoolQuery.mockResolvedValue(rpcResult(receipt({ rowCount: 0 })))

    await expect(publishCopierSnapshotV2(input({ rows: [] }))).resolves.toEqual(
      receipt({ rowCount: 0 })
    )
    const payload = JSON.parse(String(mockPoolQuery.mock.calls[0][1][0]))
    expect(payload.rows).toEqual([])
  })

  it.each([
    ['extra input key', { ...input(), extra: true }],
    ['invalid lane', { ...input(), lane: 'tier_d' }],
    ['zero acquisition run', input({ acquisitionSourceRunId: '0'.repeat(64) })],
    ['same wrapper and acquisition run', input({ acquisitionSourceRunId: SOURCE_RUN_ID })],
    ['malformed RAW receipt', { ...input(), rawObject: null }],
    [
      'wrong RAW content hash',
      input({ rawObject: { ...input().rawObject, contentHash: 'c'.repeat(64) } }),
    ],
    [
      'wrong RAW lane path',
      input({
        rawObject: {
          ...input().rawObject,
          storagePath:
            `binance_futures/copier_publication/tier_c/${SOURCE_RUN_ID}/` +
            `copier_snapshot_${SOURCE_RUN_ID}.json.gz`,
        },
      }),
    ],
    ['extra RAW receipt key', { ...input(), rawObject: { ...input().rawObject, bytes: 100 } }],
    ['unverified evidence', { ...input(), evidenceState: 'rejected' }],
    ['terminal blocker', { ...input(), blockerReasons: ['caller_limit'] }],
    ['extra row key', { ...input(), rows: [{ ...copierRow, privateIdentity: 'leak' }] }],
  ])('rejects invalid V2 input before database I/O: %s', async (_label, invalid) => {
    await expect(publishCopierSnapshotV2(invalid as PublishCopierSnapshotV2Input)).rejects.toThrow(
      '[copier-snapshot]'
    )
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['extra key', { ...receipt(), extra: true }],
    ['missing key', { ...receipt(), lane: undefined }],
    ['wrong lane', receipt({ lane: 'tier_c' })],
    ['wrong wrapper run', receipt({ sourceRunId: 'c'.repeat(64) })],
    ['wrong acquisition run', receipt({ acquisitionSourceRunId: 'c'.repeat(64) })],
    ['wrong observation', receipt({ observedAt: '2026-08-04T09:00:00.000Z' })],
    ['wrong count', receipt({ rowCount: 2 })],
    ['bad receipt id', receipt({ receiptId: 0 })],
    ['bad publish clock', receipt({ publishedAt: '2026-08-04 10:00:01Z' })],
  ])('rejects a malformed or drifted V2 receipt: %s', async (_label, invalidReceipt) => {
    mockPoolQuery.mockResolvedValue(rpcResult(invalidReceipt))

    await expect(publishCopierSnapshotV2(input())).rejects.toThrow('[copier-snapshot]')
  })

  it.each([
    ['wrong command', { ...rpcResult(), command: 'UPDATE' }],
    ['zero rows', { ...rpcResult(), rowCount: 0, rows: [] }],
    ['extra outer field', { ...rpcResult(), rows: [{ receipt: receipt(), extra: true }] }],
  ])('rejects an invalid V2 RPC envelope: %s', async (_label, invalidResult) => {
    mockPoolQuery.mockResolvedValue(invalidResult)

    await expect(publishCopierSnapshotV2(input())).rejects.toThrow('[copier-snapshot]')
  })
})
